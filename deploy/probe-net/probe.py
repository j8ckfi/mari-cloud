#!/usr/bin/env python3
"""SCRATCH — Gate 2 (outbound WebSocket) probe. Runs INSIDE a Cloudflare container.

Deliberately dependency-free: raw socket + ssl + a hand-rolled RFC 6455 client,
so the only things under test are the platform's egress path and TLS on 443 —
not a library's opinion of them.

What it asserts, byte-for-byte:
  * the frames it sends are the exact bytes `mari_proto::encode_frame` produced
    (baked in as .frame files by deploy/probe-net/genfix);
  * the frames it receives are byte-identical to the Rust-encoded control frames,
    while having been encoded live by the real TypeScript codec in the Worker.

Everything it learns goes to /tmp/probe-report.json, to the Worker over the
WebSocket as a text frame, and to the Worker over plain HTTPS.
"""

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import threading
import time
import traceback
from urllib.parse import urlparse

FIXDIR = os.environ.get("PROBE_FIXTURES", "/probe/fixtures")
WS_URL = os.environ.get("PROBE_WS_URL", "")
HOLD_SECONDS = int(os.environ.get("PROBE_HOLD_SECONDS", "200"))
MODE = os.environ.get("PROBE_MODE", "full")
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

REPORT = {
    "started_at": time.time(),
    "mode": MODE,
    "hold_seconds": HOLD_SECONDS,
    "env": {k: v for k, v in os.environ.items() if k.startswith("PROBE_")},
    "phases": {},
    "errors": [],
}


def fixture(name):
    with open(os.path.join(FIXDIR, name), "rb") as f:
        return f.read()


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def now_ms():
    return time.monotonic() * 1000.0


# --------------------------------------------------------------------------
# RFC 6455 framing (client side: every frame masked, per spec)
# --------------------------------------------------------------------------


def ws_encode(payload, opcode=0x2):
    head = bytearray()
    head.append(0x80 | opcode)  # FIN + opcode
    n = len(payload)
    mask_bit = 0x80
    if n < 126:
        head.append(mask_bit | n)
    elif n < 65536:
        head.append(mask_bit | 126)
        head += struct.pack(">H", n)
    else:
        head.append(mask_bit | 127)
        head += struct.pack(">Q", n)
    key = os.urandom(4)
    head += key
    masked = bytearray(payload)
    for i in range(n):
        masked[i] ^= key[i & 3]
    return bytes(head) + bytes(masked)


class WsClient:
    """A minimal, blocking WebSocket client over TLS."""

    def __init__(self, url, timeout=30.0):
        u = urlparse(url)
        self.host = u.hostname
        self.port = u.port or (443 if u.scheme == "wss" else 80)
        self.path = (u.path or "/") + (("?" + u.query) if u.query else "")
        self.scheme = u.scheme
        self.timeout = timeout
        self.timings = {}
        self.sock = None
        self.buf = b""
        self.tls_info = {}

    def connect(self, verify=True):
        t0 = now_ms()
        addrs = socket.getaddrinfo(self.host, self.port, proto=socket.IPPROTO_TCP)
        self.timings["dns_ms"] = round(now_ms() - t0, 2)
        self.timings["resolved"] = sorted({a[4][0] for a in addrs})

        t1 = now_ms()
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.timings["tcp_ms"] = round(now_ms() - t1, 2)

        if self.scheme == "wss":
            ctx = ssl.create_default_context()
            if not verify:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            t2 = now_ms()
            self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
            self.timings["tls_ms"] = round(now_ms() - t2, 2)
            self.tls_info = {
                "version": self.sock.version(),
                "cipher": self.sock.cipher()[0] if self.sock.cipher() else None,
                "alpn": self.sock.selected_alpn_protocol(),
                "verified": verify,
            }
        else:
            self.sock = raw

        # ---- HTTP/1.1 Upgrade -------------------------------------------
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: mari-probe-net/0\r\n"
            "\r\n"
        )
        t3 = now_ms()
        self.sock.sendall(req.encode())
        self.sock.settimeout(self.timeout)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("connection closed during handshake: " + repr(head))
            head += chunk
        self.timings["upgrade_ms"] = round(now_ms() - t3, 2)

        header_blob, _, rest = head.partition(b"\r\n\r\n")
        self.buf = rest
        status_line = header_blob.split(b"\r\n")[0].decode("latin1")
        headers = {}
        for line in header_blob.split(b"\r\n")[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                headers[k.decode("latin1").lower()] = v.decode("latin1").strip()
        if "101" not in status_line:
            raise RuntimeError(f"upgrade refused: {status_line} :: {headers}")
        expect = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expect:
            raise RuntimeError(
                f"bad Sec-WebSocket-Accept: {headers.get('sec-websocket-accept')} != {expect}"
            )
        self.handshake = {"status": status_line, "headers": headers}
        return self

    # ---- frame IO --------------------------------------------------------

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("peer closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, payload, opcode=0x2):
        self.sock.sendall(ws_encode(payload, opcode))

    def recv(self):
        """Return (opcode, payload) of the next complete (de-fragmented) message."""
        frags = b""
        first_op = None
        while True:
            b0, b1 = self._recv_exact(2)
            fin = b0 & 0x80
            op = b0 & 0x0F
            masked = b1 & 0x80
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv_exact(8))[0]
            mask_key = self._recv_exact(4) if masked else None
            payload = self._recv_exact(n) if n else b""
            if mask_key:
                payload = bytes(c ^ mask_key[i & 3] for i, c in enumerate(payload))
            if op == 0x9:  # ping -> pong, keep waiting
                self.send(payload, opcode=0xA)
                continue
            if op == 0xA:  # pong
                continue
            if op == 0x8:  # close
                return (0x8, payload)
            if op != 0x0:
                first_op = op
            frags += payload
            if fin:
                return (first_op, frags)

    def close(self):
        try:
            self.send(struct.pack(">H", 1000), opcode=0x8)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Phases
# --------------------------------------------------------------------------


def exchange(ws, out_bytes, expect_bytes, label):
    """Send bytes, wait for the reply, assert it is byte-identical to expect."""
    t0 = now_ms()
    ws.send(out_bytes)
    op, got = ws.recv()
    rtt = round(now_ms() - t0, 2)
    ok = op == 0x2 and got == expect_bytes
    return {
        "label": label,
        "sent_len": len(out_bytes),
        "sent_sha256": sha256(out_bytes),
        "recv_len": len(got),
        "recv_sha256": sha256(got),
        "expect_sha256": sha256(expect_bytes),
        "byte_exact": ok,
        "opcode": op,
        "rtt_ms": rtt,
    }, rtt


def percentile(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    k = int(round((p / 100.0) * (len(s) - 1)))
    return round(s[k], 2)


def run_probe():
    hello = fixture("sup_hello.frame")
    journal = fixture("sup_journal_big.frame")
    ctl_start = fixture("ctl_start_run.frame")
    ctl_input = fixture("ctl_input.frame")
    REPORT["fixtures"] = {
        "sup_hello.frame": {"len": len(hello), "sha256": sha256(hello)},
        "sup_journal_big.frame": {"len": len(journal), "sha256": sha256(journal)},
        "ctl_start_run.frame": {"len": len(ctl_start), "sha256": sha256(ctl_start)},
        "ctl_input.frame": {"len": len(ctl_input), "sha256": sha256(ctl_input)},
    }

    # ---- Phase A: can we open wss:// on 443 at all? ----------------------
    ws = WsClient(WS_URL)
    try:
        ws.connect(verify=True)
        verified = True
    except ssl.SSLError as e:
        REPORT["errors"].append(f"verified TLS failed: {e!r}")
        ws = WsClient(WS_URL)
        ws.connect(verify=False)
        verified = False
    REPORT["phases"]["A_connect"] = {
        "ok": True,
        "url": WS_URL,
        "tls_verified": verified,
        "tls": ws.tls_info,
        "timings": ws.timings,
        "handshake_status": ws.handshake["status"],
        "server_headers": ws.handshake["headers"],
    }
    print("PHASE A ok", json.dumps(ws.timings), flush=True)

    # ---- Phase B: byte-exact framed-CBOR round trip, both directions ----
    b = []
    r, _ = exchange(ws, hello, ctl_start, "hello -> start_run")
    b.append(r)
    r, _ = exchange(ws, journal, ctl_input, "journal_frame(64KiB) -> input")
    b.append(r)
    # Two protocol frames coalesced into ONE WebSocket message; the peer's
    # FrameReader must split them and answer with both replies coalesced.
    r, _ = exchange(ws, hello + journal, ctl_start + ctl_input, "coalesced hello+journal")
    b.append(r)
    # And the reverse split: one protocol frame delivered as two WS messages is
    # not expressible here (a WS message is atomic), so instead verify a second
    # 64 KiB frame right after a small one, back to back without waiting.
    ws.send(hello)
    ws.send(journal)
    op1, got1 = ws.recv()
    op2, got2 = ws.recv()
    b.append(
        {
            "label": "pipelined hello,journal (2 msgs, no wait)",
            "byte_exact": got1 == ctl_start and got2 == ctl_input,
            "recv1_sha256": sha256(got1),
            "recv2_sha256": sha256(got2),
        }
    )
    REPORT["phases"]["B_bytes"] = {"exchanges": b, "all_byte_exact": all(x["byte_exact"] for x in b)}
    print("PHASE B", json.dumps(REPORT["phases"]["B_bytes"]["all_byte_exact"]), flush=True)

    # ---- Phase C: latency ------------------------------------------------
    small, big = [], []
    for _ in range(25):
        _, rtt = exchange(ws, hello, ctl_start, "lat-small")
        small.append(rtt)
    for _ in range(10):
        _, rtt = exchange(ws, journal, ctl_input, "lat-64k")
        big.append(rtt)
    REPORT["phases"]["C_latency"] = {
        "small_94B_rtt_ms": {
            "n": len(small),
            "min": round(min(small), 2),
            "p50": percentile(small, 50),
            "p90": percentile(small, 90),
            "p99": percentile(small, 99),
            "max": round(max(small), 2),
        },
        "big_64KiB_rtt_ms": {
            "n": len(big),
            "min": round(min(big), 2),
            "p50": percentile(big, 50),
            "max": round(max(big), 2),
        },
    }
    print("PHASE C", json.dumps(REPORT["phases"]["C_latency"]), flush=True)

    # ---- Phase C2: largest single WebSocket message that survives --------
    # marid's MAX_FRAME_LEN is 64 MiB (contracts §2); the edge may be stricter.
    sizes = []
    sep = "&" if "?" in WS_URL else "?"
    size_url = WS_URL + sep + "mode=size"
    for n in (65536, 262144, 1048576, 1048577, 4194304):
        entry = {"bytes": n}
        sw = WsClient(size_url, timeout=45.0)
        try:
            sw.connect()
            t0 = now_ms()
            sw.send(b"\x5a" * n)
            op, got = sw.recv()
            entry["ms"] = round(now_ms() - t0, 2)
            if op == 0x8:
                entry["ok"] = False
                entry["close"] = repr(got[:64])
            else:
                entry["ok"] = json.loads(got.decode()).get("len") == n
                entry["echo"] = got.decode()[:120]
        except Exception as e:
            entry["ok"] = False
            entry["error"] = f"{type(e).__name__}: {e}"
        finally:
            sw.close()
        sizes.append(entry)
        print("SIZE", json.dumps(entry), flush=True)
    REPORT["phases"]["C2_message_size"] = sizes
    write_report()

    # ---- Phase D: hold the socket open ----------------------------------
    hold = {
        "target_seconds": HOLD_SECONDS,
        "interval_seconds": 15,
        "beats": [],
        "failed_at_s": None,
        "error": None,
        "survived_seconds": None,
    }
    t_start = time.monotonic()
    beat = 0
    try:
        while time.monotonic() - t_start < HOLD_SECONDS:
            time.sleep(15)
            beat += 1
            elapsed = round(time.monotonic() - t_start, 1)
            r, rtt = exchange(ws, hello, ctl_start, f"beat-{beat}")
            hold["beats"].append(
                {"beat": beat, "at_s": elapsed, "byte_exact": r["byte_exact"], "rtt_ms": rtt}
            )
            print(f"BEAT {beat} at {elapsed}s rtt={rtt}ms exact={r['byte_exact']}", flush=True)
            REPORT["phases"]["D_hold"] = hold
            write_report()
    except Exception as e:  # socket died mid-hold — that is the answer
        hold["failed_at_s"] = round(time.monotonic() - t_start, 1)
        hold["error"] = f"{type(e).__name__}: {e}"
        print("HOLD FAILED", hold["error"], flush=True)
    hold["survived_seconds"] = round(time.monotonic() - t_start, 1)
    hold["all_beats_byte_exact"] = all(x["byte_exact"] for x in hold["beats"])
    REPORT["phases"]["D_hold"] = hold

    # ---- Phase E: report over the socket and over plain HTTPS ------------
    REPORT["finished_at"] = time.time()
    try:
        ws.send(json.dumps({"t": "report", "report": REPORT}).encode(), opcode=0x1)
        REPORT["phases"]["E_report_ws"] = "sent"
    except Exception as e:
        REPORT["phases"]["E_report_ws"] = f"failed: {e}"
    write_report()
    try:
        REPORT["phases"]["E_report_https"] = http_post_report()
    except Exception as e:
        REPORT["phases"]["E_report_https"] = f"failed: {e}"
    write_report()
    print("DONE", flush=True)
    # Leave the socket open; the harness decides when this container dies.
    while True:
        try:
            op, payload = ws.recv()
            if op == 0x8:
                REPORT["post_hold_close"] = {"at": time.time(), "payload": repr(payload[:64])}
                write_report()
                break
        except Exception as e:
            REPORT["post_hold_error"] = f"{type(e).__name__}: {e}"
            REPORT["post_hold_error_at"] = time.time()
            write_report()
            break
    time.sleep(3600)


def http_post_report():
    """Plain HTTPS POST — an independent check that ordinary egress works."""
    u = urlparse(WS_URL)
    host = u.hostname
    path = "/report" + (("?" + u.query) if u.query else "")
    body = json.dumps({"via": "https", "report": REPORT}).encode()
    ctx = ssl.create_default_context()
    t0 = now_ms()
    raw = socket.create_connection((host, 443), timeout=30)
    s = ctx.wrap_socket(raw, server_hostname=host)
    s.sendall(
        (
            f"POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode()
        + body
    )
    resp = b""
    while True:
        c = s.recv(65536)
        if not c:
            break
        resp += c
    s.close()
    return {"ms": round(now_ms() - t0, 2), "status": resp.split(b"\r\n")[0].decode("latin1")}


def write_report():
    with open("/tmp/probe-report.json", "w") as f:
        json.dump(REPORT, f, indent=1, default=str)


# --------------------------------------------------------------------------
# A tiny inbound server, so the harness can test whether an INBOUND socket
# renews the container's inactivity timer (memo unverified item 5).
# --------------------------------------------------------------------------


def serve_inbound():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", 8080))
    srv.listen(8)
    while True:
        try:
            conn, _ = srv.accept()
            threading.Thread(target=handle_inbound, args=(conn,), daemon=True).start()
        except Exception:
            traceback.print_exc()


def handle_inbound(conn):
    try:
        head = b""
        while b"\r\n\r\n" not in head:
            c = conn.recv(4096)
            if not c:
                return
            head += c
        lines = head.split(b"\r\n")
        req = lines[0].decode("latin1")
        headers = {}
        for line in lines[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                headers[k.decode("latin1").lower()] = v.decode("latin1").strip()

        if "upgrade" in headers.get("connection", "").lower() or headers.get("upgrade", "").lower() == "websocket":
            key = headers.get("sec-websocket-key", "")
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            conn.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                    f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode()
            )
            REPORT.setdefault("inbound", []).append({"ws_open_at": time.time()})
            write_report()
            # Echo binary frames back, unmasked (server side).
            buf = b""
            while True:
                c = conn.recv(65536)
                if not c:
                    break
                buf += c
                while len(buf) >= 2:
                    b1 = buf[1] & 0x7F
                    off = 2
                    if b1 == 126:
                        if len(buf) < 4:
                            break
                        n = struct.unpack(">H", buf[2:4])[0]
                        off = 4
                    elif b1 == 127:
                        if len(buf) < 10:
                            break
                        n = struct.unpack(">Q", buf[2:10])[0]
                        off = 10
                    else:
                        n = b1
                    masked = buf[1] & 0x80
                    need = off + (4 if masked else 0) + n
                    if len(buf) < need:
                        break
                    mk = buf[off : off + 4] if masked else None
                    pl = buf[off + (4 if masked else 0) : need]
                    if mk:
                        pl = bytes(x ^ mk[i & 3] for i, x in enumerate(pl))
                    buf = buf[need:]
                    op = buf and 0
                    # reply with the same payload, server frames are unmasked
                    head_out = bytearray([0x82])
                    if len(pl) < 126:
                        head_out.append(len(pl))
                    elif len(pl) < 65536:
                        head_out.append(126)
                        head_out += struct.pack(">H", len(pl))
                    else:
                        head_out.append(127)
                        head_out += struct.pack(">Q", len(pl))
                    conn.sendall(bytes(head_out) + pl)
                    REPORT.setdefault("inbound_frames", 0)
                    REPORT["inbound_frames"] += 1
            REPORT.setdefault("inbound", []).append({"ws_close_at": time.time()})
            write_report()
            return

        body = json.dumps(REPORT, default=str).encode()
        conn.sendall(
            (
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
            ).encode()
            + body
        )
    except Exception:
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    threading.Thread(target=serve_inbound, daemon=True).start()
    print("probe starting", WS_URL, "mode", MODE, flush=True)
    write_report()
    try:
        run_probe()
    except Exception as e:
        REPORT["fatal"] = f"{type(e).__name__}: {e}"
        REPORT["traceback"] = traceback.format_exc()
        print("FATAL", REPORT["fatal"], flush=True)
        traceback.print_exc()
        write_report()
        # Stay alive so the harness can read the failure out with exec().
        time.sleep(3600)
        sys.exit(1)
