//! WebSocket transport helpers: TLS, the control-URL scheme policy, framed-CBOR
//! send/recv, and reconnect backoff.
//!
//! The supervisor <-> control-plane stream carries back-to-back length-prefixed
//! CBOR frames (contracts §2), even over a WebSocket: each binary message
//! payload is one [`mari_proto::encode_frame`] frame. Incoming payloads are fed
//! through a [`mari_proto::FrameReader`] so a message split or coalesced by the
//! transport still decodes into whole protocol values.
//!
//! # Transport security
//!
//! The very first thing the supervisor puts on this socket is its `Hello`, which
//! carries the computer id, the fencing epoch and the **one-time wake token**
//! (contracts §5.1). That is a bearer credential for one computer's control
//! channel, and every journal byte of every run follows it. So:
//!
//! - `wss://` works — [`install_crypto_provider`] plus the crate's
//!   `rustls-tls-webpki-roots` feature make it work; without either, a `wss://`
//!   URL fails before a packet moves (`Url(TlsFeatureNotEnabled)`, or a panic
//!   inside rustls for want of a process crypto provider).
//! - `ws://` is **refused** unless the peer is provably not on the public
//!   internet ([`classify_control_url`]) or the operator opted in explicitly.
//!   A private instance on `ws://localhost:8787` stays ergonomic; a public
//!   origin cannot be downgraded to cleartext by a config typo or by an
//!   attacker who can rewrite `MARI_CONTROL_URL`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures_util::SinkExt;
use mari_proto::{FrameReader, encode_frame, from_cbor};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Response;
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info};

/// The control-plane socket type: TLS or plaintext behind one type.
pub type ControlStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Install the process-wide rustls [`rustls::crypto::CryptoProvider`].
///
/// `tokio-tungstenite` declares rustls with `default-features = false`, so the
/// rustls in this binary ships **no** provider of its own and
/// `ClientConfig::builder()` — which every `wss://` dial goes through — panics
/// with "no process-level CryptoProvider available". Calling this once at
/// startup is what makes TLS work at all; it is idempotent, so tests (and a
/// second call from anywhere) are harmless.
pub fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return;
    }
    // `install_default` races with any other installer and returns Err if it
    // lost; either way a provider is installed afterwards, which is all we need.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Why a plaintext `ws://` peer is considered off the public internet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalReason {
    /// 127.0.0.0/8, ::1, or the name `localhost` (and `*.localhost`, RFC 6761).
    Loopback,
    /// RFC 1918 (10/8, 172.16/12, 192.168/16).
    Private,
    /// 169.254/16 or fe80::/10.
    LinkLocal,
    /// fc00::/7 — IPv6 unique local (Fly/Sprites 6PN lives here).
    UniqueLocal,
}

/// The verdict of the control-URL scheme policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlPolicy {
    /// `wss://` — encrypted; always allowed.
    Tls,
    /// `ws://` to a host that resolves only to non-public addresses.
    PlainLocal(LocalReason),
    /// `ws://` allowed only because `--allow-insecure-ws` / `MARI_ALLOW_INSECURE_WS`
    /// is set. The token travels in cleartext; that is the operator's call.
    PlainOptIn,
}

/// A control URL that passed the policy, plus the address the dial must use.
#[derive(Clone, Debug)]
pub struct ControlDial {
    /// Why this URL is allowed.
    pub policy: UrlPolicy,
    /// For a `PlainLocal` verdict: the address whose locality was actually
    /// verified. The socket is opened to **this** address, so a DNS answer that
    /// changes between the check and the dial cannot turn a host that classified
    /// as local into a public one. `None` for TLS (the certificate is the
    /// identity check) and for the explicit opt-in (nothing was verified).
    pub addr: Option<SocketAddr>,
}

/// A control URL that must not be dialed as configured.
#[derive(Debug, thiserror::Error)]
pub enum UrlPolicyError {
    /// The URL has no host, so there is nothing to classify.
    #[error("control URL {url:?} has no host")]
    NoHost {
        /// The offending URL.
        url: String,
    },
    /// Not `ws://` or `wss://`.
    #[error("control URL {url:?}: unsupported scheme {scheme:?} (expected ws:// or wss://)")]
    Scheme {
        /// The offending URL.
        url: String,
        /// The scheme it carried.
        scheme: String,
    },
    /// Plaintext to a peer that is (or may be) on the public internet.
    #[error(
        "refusing to dial {url:?} in cleartext: the Hello carries this computer's wake token and \
         every journal byte follows it, but {host} resolves to the public address {addr}. Use \
         wss://, or set MARI_ALLOW_INSECURE_WS=1 to accept a cleartext control channel."
    )]
    Downgrade {
        /// The offending URL.
        url: String,
        /// Its host.
        host: String,
        /// The first public address it resolved to.
        addr: IpAddr,
    },
    /// The host could not be resolved, so its locality is unknown. Transient:
    /// DNS is often not up yet in a freshly materialized container.
    #[error("cannot classify control URL {url:?}: resolving {host:?} failed: {source}")]
    Unresolved {
        /// The offending URL.
        url: String,
        /// Its host.
        host: String,
        /// The resolver error.
        source: std::io::Error,
    },
}

impl UrlPolicyError {
    /// Whether this is a configuration error that no amount of retrying fixes.
    /// A failed resolution is not: it is retried on the next connect attempt.
    pub fn is_fatal(&self) -> bool {
        !matches!(self, UrlPolicyError::Unresolved { .. })
    }
}

/// Is this address off the public internet?
fn local_reason(ip: IpAddr) -> Option<LocalReason> {
    match ip {
        IpAddr::V4(v4) => local_reason_v4(v4),
        IpAddr::V6(v6) => {
            // An IPv4-mapped address (::ffff:a.b.c.d) is an IPv4 peer: classify
            // the address that will actually be talked to, not its wrapper.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return local_reason_v4(v4);
            }
            local_reason_v6(v6)
        }
    }
}

fn local_reason_v4(v4: Ipv4Addr) -> Option<LocalReason> {
    if v4.is_loopback() {
        Some(LocalReason::Loopback)
    } else if v4.is_private() {
        Some(LocalReason::Private)
    } else if v4.is_link_local() {
        Some(LocalReason::LinkLocal)
    } else {
        None
    }
}

fn local_reason_v6(v6: Ipv6Addr) -> Option<LocalReason> {
    let first = v6.segments()[0];
    if v6.is_loopback() {
        Some(LocalReason::Loopback)
    } else if first & 0xfe00 == 0xfc00 {
        // fc00::/7, unique local. Fly/Sprites 6PN addresses are fdaa::/16.
        Some(LocalReason::UniqueLocal)
    } else if first & 0xffc0 == 0xfe80 {
        // fe80::/10, link local.
        Some(LocalReason::LinkLocal)
    } else {
        None
    }
}

/// The host of a URI with any IPv6 brackets stripped, i.e. the string that both
/// `IpAddr::from_str` and the resolver want (`tokio-tungstenite` does the same
/// for the TLS server name).
fn uri_host(uri: &Uri) -> Option<&str> {
    let host = uri.host()?;
    Some(
        match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
            Some(inner) => inner,
            None => host,
        },
    )
}

/// The port a URI dials: explicit, else the scheme default.
fn uri_port(uri: &Uri) -> Option<u16> {
    uri.port_u16().or(match uri.scheme_str() {
        Some("wss") => Some(443),
        Some("ws") => Some(80),
        _ => None,
    })
}

/// Apply the scheme policy to `url` (spec 10.1's spirit at the transport layer).
///
/// `wss://` passes. `ws://` passes only when the host is provably not on the
/// public internet — an IP literal that is loopback/private/link-local/ULA, the
/// name `localhost` (or `*.localhost`), or a name **every** one of whose
/// resolved addresses is one of those — or when `allow_insecure` is set, which
/// is the deliberate escape hatch for an operator who terminates TLS elsewhere.
///
/// Resolving is what makes this usable in practice: a private instance hands its
/// computers `ws://host.docker.internal:8787` or `ws://172.17.0.1:8787`, and a
/// container on a bridge network dials a sibling by name. Those are exactly the
/// hosts that resolve to private space, and the check lets them through while a
/// `ws://` to a public origin is refused.
pub async fn classify_control_url(
    url: &str,
    allow_insecure: bool,
) -> std::result::Result<ControlDial, UrlPolicyError> {
    let uri: Uri = url.parse().map_err(|_| UrlPolicyError::NoHost {
        url: url.to_string(),
    })?;
    let host = uri_host(&uri).ok_or_else(|| UrlPolicyError::NoHost {
        url: url.to_string(),
    })?;
    match uri.scheme_str() {
        Some("wss") => {
            return Ok(ControlDial {
                policy: UrlPolicy::Tls,
                addr: None,
            });
        }
        Some("ws") => {}
        other => {
            return Err(UrlPolicyError::Scheme {
                url: url.to_string(),
                scheme: other.unwrap_or("").to_string(),
            });
        }
    }
    if allow_insecure {
        // Nothing is verified, so nothing is pinned: dial exactly as configured.
        return Ok(ControlDial {
            policy: UrlPolicy::PlainOptIn,
            addr: None,
        });
    }
    let port = uri_port(&uri).unwrap_or(80);

    // An IP literal needs no resolver, and pinning it is trivially exact.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match local_reason(ip) {
            Some(reason) => Ok(ControlDial {
                policy: UrlPolicy::PlainLocal(reason),
                addr: Some(SocketAddr::new(ip, port)),
            }),
            None => Err(UrlPolicyError::Downgrade {
                url: url.to_string(),
                host: host.to_string(),
                addr: ip,
            }),
        };
    }
    // RFC 6761: `localhost` and anything under it is loopback by definition.
    let lowered = host.to_ascii_lowercase();
    if lowered == "localhost" || lowered.ends_with(".localhost") {
        let addr = tokio::net::lookup_host((host, port))
            .await
            .map_err(|source| UrlPolicyError::Unresolved {
                url: url.to_string(),
                host: host.to_string(),
                source,
            })?
            .next();
        return Ok(ControlDial {
            policy: UrlPolicy::PlainLocal(LocalReason::Loopback),
            addr,
        });
    }
    // A name: EVERY address it resolves to must be non-public. One public answer
    // refuses the dial — a name that resolves to both is a name an attacker (or
    // a split-horizon misconfiguration) can steer onto the public one.
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|source| UrlPolicyError::Unresolved {
            url: url.to_string(),
            host: host.to_string(),
            source,
        })?
        .collect();
    classify_addrs(url, host, &addrs)
}

/// The locality verdict for a resolved host: every address must be non-public,
/// and the first one is what the dial is pinned to. Split out from
/// [`classify_control_url`] so the rule can be tested against exact address
/// lists instead of whatever the machine's resolver happens to answer.
fn classify_addrs(
    url: &str,
    host: &str,
    addrs: &[SocketAddr],
) -> std::result::Result<ControlDial, UrlPolicyError> {
    if addrs.is_empty() {
        return Err(UrlPolicyError::Unresolved {
            url: url.to_string(),
            host: host.to_string(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "no addresses for this host"),
        });
    }
    let mut verdict = None;
    for addr in addrs {
        match local_reason(addr.ip()) {
            Some(reason) => verdict = verdict.or(Some((reason, *addr))),
            None => {
                return Err(UrlPolicyError::Downgrade {
                    url: url.to_string(),
                    host: host.to_string(),
                    addr: addr.ip(),
                });
            }
        }
    }
    let (reason, addr) = verdict.expect("non-empty and every address classified");
    Ok(ControlDial {
        policy: UrlPolicy::PlainLocal(reason),
        addr: Some(addr),
    })
}

/// Dial the control plane, enforcing the scheme policy.
///
/// `connector` is the TLS seam: `None` uses the webpki root store (production),
/// and `Some(Connector::Rustls(..))` lets a test trust a self-signed local
/// server. A plaintext dial goes to the address [`classify_control_url`]
/// verified, so the locality check cannot be undone by a second DNS answer.
pub async fn connect_control(
    url: &str,
    allow_insecure: bool,
    connector: Option<Connector>,
) -> Result<(ControlStream, Response)> {
    // Cheap when already installed (one atomic load), and it makes this function
    // safe to call on its own: without a provider, the rustls handshake panics
    // rather than returning an error.
    install_crypto_provider();
    let dial = classify_control_url(url, allow_insecure).await?;
    match dial.policy {
        UrlPolicy::Tls => debug!(%url, "control channel: wss (TLS)"),
        UrlPolicy::PlainLocal(reason) => {
            debug!(%url, ?reason, "control channel: plaintext ws to a non-public peer")
        }
        UrlPolicy::PlainOptIn => info!(
            %url,
            "control channel: plaintext ws by explicit opt-in (MARI_ALLOW_INSECURE_WS); \
             the wake token and every journal byte travel in cleartext"
        ),
    }
    let request = url.into_client_request()?;
    let socket = match dial.addr {
        Some(addr) => TcpStream::connect(addr).await?,
        None => {
            let uri = request.uri().clone();
            let host =
                uri_host(&uri).ok_or_else(|| anyhow::anyhow!("control URL {url:?} has no host"))?;
            let port =
                uri_port(&uri).ok_or_else(|| anyhow::anyhow!("control URL {url:?} has no port"))?;
            TcpStream::connect((host, port)).await?
        }
    };
    let (stream, response) =
        tokio_tungstenite::client_async_tls_with_config(request, socket, None, connector).await?;
    Ok((stream, response))
}

/// A rustls client config that trusts exactly `roots` — the test seam for a
/// `wss://` handshake against a local server with a self-signed certificate.
/// Not used in production: production trusts the webpki root store.
pub fn connector_trusting(
    roots: impl IntoIterator<Item = rustls::pki_types::CertificateDer<'static>>,
) -> Result<Connector> {
    install_crypto_provider();
    let mut store = rustls::RootCertStore::empty();
    for cert in roots {
        store.add(cert)?;
    }
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(store)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

/// An empty WebSocket ping: the supervisor-level keepalive frame (spec 5.4's
/// hold is per-run; this one exists whether or not a run does).
pub fn keepalive_ping() -> Message {
    Message::Ping(Bytes::new())
}

/// Encode a protocol value as one length-prefixed frame and send it as a binary
/// WebSocket message.
pub async fn send_framed<S, T>(sink: &mut S, value: &T) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
    T: Serialize,
{
    let frame = encode_frame(value)?;
    sink.send(Message::binary(frame)).await?;
    Ok(())
}

/// Decode every complete protocol value contained in an incoming binary
/// message's payload (usually exactly one), appending them to `out`.
pub fn decode_payload<T: DeserializeOwned>(
    reader: &mut FrameReader,
    payload: &[u8],
    out: &mut Vec<T>,
) -> Result<()> {
    reader.push(payload);
    while let Some(body) = reader.next_body()? {
        out.push(from_cbor::<T>(&body)?);
    }
    Ok(())
}

/// Exponential reconnect backoff with a cap, reset on a successful connection.
#[derive(Clone, Debug)]
pub struct Backoff {
    current: Duration,
    initial: Duration,
    max: Duration,
}

impl Backoff {
    /// A backoff from `initial`, doubling up to `max`.
    pub fn new(initial: Duration, max: Duration) -> Self {
        Self {
            current: initial,
            initial,
            max,
        }
    }

    /// The delay to wait before the next reconnect attempt, then double it
    /// (saturating at `max`).
    pub fn next_delay(&mut self) -> Duration {
        let d = self.current;
        self.current = (self.current * 2).min(self.max);
        d
    }

    /// Reset to the initial delay after a successful connection.
    pub fn reset(&mut self) {
        self.current = self.initial;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff::new(Duration::from_millis(100), Duration::from_secs(5))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use mari_proto::{ComputerId, ControlMessage, Epoch, PROTO_VERSION, SupervisorMessage};

    fn sock(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    // -----------------------------------------------------------------------
    // Scheme policy: wss always; plaintext only to a provably non-public peer.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn wss_is_allowed_without_touching_the_resolver() {
        // A public host over TLS is exactly the production case (app.mari.sh).
        // No DNS is needed to decide it, which is why this test is hermetic.
        let dial = classify_control_url("wss://app.mari.sh/supervisor/comp-1", false)
            .await
            .expect("wss must be allowed");
        assert_eq!(dial.policy, UrlPolicy::Tls);
        assert!(
            dial.addr.is_none(),
            "TLS identity comes from the certificate"
        );
    }

    #[tokio::test]
    async fn plaintext_to_a_public_address_is_refused_and_is_fatal() {
        let err = classify_control_url("ws://1.1.1.1:8787/supervisor/comp-1", false)
            .await
            .expect_err("plaintext to a public peer must be refused");
        assert!(
            matches!(err, UrlPolicyError::Downgrade { .. }),
            "expected a downgrade refusal, got {err:?}"
        );
        assert!(
            err.is_fatal(),
            "a downgrade is a config error, not transient"
        );
        let msg = err.to_string();
        assert!(
            msg.contains("cleartext") && msg.contains("MARI_ALLOW_INSECURE_WS"),
            "the refusal must say why and how to override: {msg}"
        );
    }

    #[tokio::test]
    async fn plaintext_to_a_public_ipv6_address_is_refused() {
        let err = classify_control_url("ws://[2606:4700::1111]:8787/", false)
            .await
            .expect_err("plaintext to a public IPv6 peer must be refused");
        assert!(matches!(err, UrlPolicyError::Downgrade { .. }), "{err:?}");
    }

    /// A private instance must stay ergonomic: every address family a local
    /// deployment actually uses is allowed in plaintext, and the dial is pinned
    /// to the address that was verified.
    #[tokio::test]
    async fn plaintext_to_non_public_addresses_is_allowed_and_pinned() {
        let cases = [
            (
                "ws://127.0.0.1:8787/",
                LocalReason::Loopback,
                "127.0.0.1:8787",
            ),
            ("ws://[::1]:8787/", LocalReason::Loopback, "[::1]:8787"),
            // Docker's default bridge gateway — what a private instance hands a
            // computer when it detects it is itself containerized.
            (
                "ws://172.17.0.1:8787/",
                LocalReason::Private,
                "172.17.0.1:8787",
            ),
            ("ws://10.1.2.3:8787/", LocalReason::Private, "10.1.2.3:8787"),
            (
                "ws://192.168.65.254:8787/",
                LocalReason::Private,
                "192.168.65.254:8787",
            ),
            (
                "ws://169.254.7.7:8787/",
                LocalReason::LinkLocal,
                "169.254.7.7:8787",
            ),
            // Fly/Sprites 6PN private networking is fdaa::/16 inside fc00::/7.
            (
                "ws://[fdaa::3]:8787/",
                LocalReason::UniqueLocal,
                "[fdaa::3]:8787",
            ),
            // An IPv4-mapped literal is an IPv4 peer, and must classify as one.
            (
                "ws://[::ffff:127.0.0.1]:8787/",
                LocalReason::Loopback,
                "[::ffff:127.0.0.1]:8787",
            ),
        ];
        for (url, reason, addr) in cases {
            let dial = classify_control_url(url, false)
                .await
                .unwrap_or_else(|e| panic!("{url} must be allowed: {e}"));
            assert_eq!(dial.policy, UrlPolicy::PlainLocal(reason), "{url}");
            assert_eq!(dial.addr, Some(sock(addr)), "{url} must pin its address");
        }
    }

    /// The default port matters: it is what the pinned address carries when the
    /// URL omits one, and dialing the wrong port is a silent hang.
    #[tokio::test]
    async fn a_url_without_a_port_pins_the_scheme_default() {
        let dial = classify_control_url("ws://127.0.0.1/supervisor/c", false)
            .await
            .unwrap();
        assert_eq!(dial.addr, Some(sock("127.0.0.1:80")));
    }

    #[tokio::test]
    async fn localhost_by_name_is_loopback() {
        let dial = classify_control_url("ws://localhost:8787/supervisor/c", false)
            .await
            .expect("localhost must be allowed in plaintext");
        assert_eq!(dial.policy, UrlPolicy::PlainLocal(LocalReason::Loopback));
        let addr = dial.addr.expect("localhost must resolve to an address");
        assert!(addr.ip().is_loopback(), "resolved {addr} is not loopback");
        assert_eq!(addr.port(), 8787);
    }

    #[tokio::test]
    async fn a_non_ws_scheme_is_refused() {
        for url in ["https://app.mari.sh/supervisor/c", "gopher://nope/"] {
            let err = classify_control_url(url, false).await.expect_err(url);
            assert!(
                matches!(err, UrlPolicyError::Scheme { .. }),
                "{url}: {err:?}"
            );
            assert!(err.is_fatal());
        }
    }

    #[tokio::test]
    async fn the_opt_in_allows_a_public_plaintext_url() {
        let dial = classify_control_url("ws://app.mari.sh/supervisor/c", true)
            .await
            .expect("the explicit opt-in must allow plaintext");
        assert_eq!(dial.policy, UrlPolicy::PlainOptIn);
        assert!(
            dial.addr.is_none(),
            "nothing was verified, so nothing may be pinned"
        );
    }

    /// The rule that makes name-based hosts safe: ONE public answer refuses the
    /// dial, even when other answers are private. Asserted against exact address
    /// lists rather than the machine's resolver, so the rule is what is tested.
    #[test]
    fn a_name_resolving_to_any_public_address_is_refused() {
        // host.docker.internal / a compose service name: all-private, allowed.
        let ok = classify_addrs(
            "ws://host.docker.internal:8787/",
            "host.docker.internal",
            &[sock("192.168.65.254:8787"), sock("[fdaa::1]:8787")],
        )
        .expect("an all-private name must be allowed");
        assert_eq!(ok.policy, UrlPolicy::PlainLocal(LocalReason::Private));
        assert_eq!(ok.addr, Some(sock("192.168.65.254:8787")));

        // A split-horizon name with one public answer: refused. An attacker who
        // can steer the resolver must not be able to get the token in the clear.
        let err = classify_addrs(
            "ws://sneaky.example:8787/",
            "sneaky.example",
            &[sock("10.0.0.1:8787"), sock("203.0.113.7:8787")],
        )
        .expect_err("one public answer must refuse the dial");
        match err {
            UrlPolicyError::Downgrade { addr, .. } => {
                assert_eq!(addr, sock("203.0.113.7:8787").ip())
            }
            other => panic!("expected a downgrade refusal, got {other:?}"),
        }

        // A name with no answers cannot be classified: transient, not fatal.
        let err = classify_addrs("ws://nowhere.invalid/", "nowhere.invalid", &[]).unwrap_err();
        assert!(matches!(err, UrlPolicyError::Unresolved { .. }), "{err:?}");
        assert!(!err.is_fatal(), "a resolution failure must be retried");
    }

    // -----------------------------------------------------------------------
    // A real wss:// handshake.
    //
    // This is the local-TLS-server variant, not a rustls-side unit path: the
    // blocker was that marid could not complete a TLS handshake AT ALL (no TLS
    // feature, no crypto provider), and only an actual handshake over an actual
    // socket proves that end to end — the feature is on, a provider is
    // installed, the certificate is verified, and framed CBOR survives the
    // encrypted stream. A self-signed leaf plus a trust override is the only way
    // to do that without reaching the public internet from a test.
    // -----------------------------------------------------------------------

    struct TlsServer {
        port: u16,
        cert: rustls::pki_types::CertificateDer<'static>,
    }

    /// A TLS listener on loopback that speaks the real framed-CBOR protocol:
    /// it reads one `Hello` and answers `HelloAck`, then closes.
    async fn spawn_tls_ws_server() -> TlsServer {
        install_crypto_provider();
        let leaf = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let cert = leaf.cert.der().clone();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(leaf.signing_key.serialize_der().into());
        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tls).await else {
                        return;
                    };
                    let mut frames = FrameReader::new();
                    while let Some(Ok(msg)) = ws.next().await {
                        if let Message::Binary(payload) = msg {
                            let mut msgs: Vec<SupervisorMessage> = Vec::new();
                            if decode_payload(&mut frames, payload.as_ref(), &mut msgs).is_err() {
                                return;
                            }
                            for m in msgs {
                                if let SupervisorMessage::Hello { .. } = m {
                                    let _ = send_framed(
                                        &mut ws,
                                        &ControlMessage::HelloAck { acked: vec![] },
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                });
            }
        });
        TlsServer { port, cert }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wss_handshake_completes_and_carries_framed_cbor() {
        let server = spawn_tls_ws_server().await;
        let url = format!("wss://localhost:{}/supervisor/comp-tls", server.port);
        let connector = connector_trusting([server.cert.clone()]).unwrap();

        let (mut ws, response) = connect_control(&url, false, Some(connector))
            .await
            .expect("a wss handshake must succeed");
        assert_eq!(
            response.status().as_u16(),
            101,
            "the WebSocket upgrade must have been accepted"
        );

        // The protocol works over TLS: Hello out, HelloAck back, framed CBOR.
        send_framed(
            &mut ws,
            &SupervisorMessage::Hello {
                computer: ComputerId::new("comp-tls"),
                epoch: Epoch::new(1),
                token: "tls-token".into(),
                proto_version: PROTO_VERSION,
            },
        )
        .await
        .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("HelloAck must arrive over TLS")
            .expect("stream ended")
            .expect("ws error");
        let payload = match reply {
            Message::Binary(b) => b,
            other => panic!("expected a binary frame, got {other:?}"),
        };
        let mut frames = FrameReader::new();
        let mut msgs: Vec<ControlMessage> = Vec::new();
        decode_payload(&mut frames, payload.as_ref(), &mut msgs).unwrap();
        assert!(
            matches!(msgs.as_slice(), [ControlMessage::HelloAck { .. }]),
            "expected one HelloAck, got {msgs:?}"
        );
    }

    /// The other half of "TLS works": it must also *verify*. With the webpki
    /// roots (production's connector) the self-signed server is rejected — and
    /// crucially the failure is a certificate failure, NOT
    /// `Url(TlsFeatureNotEnabled)`, which is what a TLS-less build returns for
    /// every wss:// URL before a packet moves.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wss_with_the_production_trust_store_rejects_an_untrusted_certificate() {
        install_crypto_provider();
        let server = spawn_tls_ws_server().await;
        let url = format!("wss://localhost:{}/supervisor/comp-tls", server.port);
        let err = connect_control(&url, false, None)
            .await
            .expect_err("an untrusted self-signed certificate must be rejected");
        let msg = format!("{err:#}");
        assert!(
            !msg.contains("TLS support not compiled in"),
            "TLS must be compiled in; got {msg}"
        );
        assert!(
            msg.to_lowercase().contains("certificate")
                || msg.to_lowercase().contains("unknown issuer")
                || msg.to_lowercase().contains("invalid peer"),
            "expected a certificate verification failure, got {msg}"
        );
    }

    #[test]
    fn backoff_doubles_and_caps_then_resets() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_millis(800));
        assert_eq!(b.next_delay(), Duration::from_millis(100));
        assert_eq!(b.next_delay(), Duration::from_millis(200));
        assert_eq!(b.next_delay(), Duration::from_millis(400));
        assert_eq!(b.next_delay(), Duration::from_millis(800));
        assert_eq!(b.next_delay(), Duration::from_millis(800));
        b.reset();
        assert_eq!(b.next_delay(), Duration::from_millis(100));
    }
}
