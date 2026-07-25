/**
 * GATE 1 probe Worker + Durable Object.
 *
 * Drives a real Cloudflare Container through `ctx.container.start/exec/destroy`
 * only — the raw API the memo says the Mari driver must use, never the Sandbox
 * SDK. It exists to run mari-core's own test binaries inside the sandbox and
 * report timings; it is a scratch app named `mari-probe-*` and is deleted when
 * the experiment ends.
 *
 * Every route requires the `x-probe-token` header to match the PROBE_TOKEN
 * secret: /exec runs an arbitrary argv inside the container, so an unauthorised
 * caller would have remote code execution on it.
 */

import { DurableObject } from "cloudflare:workers";

interface Env {
  PROBE: DurableObjectNamespace<ProbeDO>;
  PROBE_TOKEN: string;
}

const DEC = new TextDecoder();

function text(buf: ArrayBuffer | null): string {
  return buf ? DEC.decode(buf) : "";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Constant-time-ish comparison; the token is short and this is a scratch app. */
function tokenOk(given: string | null, want: string): boolean {
  if (!given || !want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export class ProbeDO extends DurableObject<Env> {
  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("no container binding on this Durable Object");
    return c;
  }

  /** One exec, awaited to completion. */
  private async run(
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ argv: string[]; exitCode: number; stdout: string; stderr: string; ms: number }> {
    const t0 = Date.now();
    const p = await this.container.exec(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await p.output();
    return {
      argv,
      exitCode: out.exitCode,
      stdout: text(out.stdout),
      stderr: text(out.stderr),
      ms: Date.now() - t0,
    };
  }

  /**
   * Start the container from a stopped state and measure how long it takes
   * before it can run a process. `exec()` does not start a stopped container,
   * so the retry loop is the measurement: the first exec that succeeds is the
   * instant the sandbox became usable.
   */
  private async startAndWait(
    entrypoint: string[],
    env: Record<string, string>,
    budgetMs = 90_000,
  ): Promise<{ startToExecReadyMs: number; attempts: number; probes: string[] }> {
    const t0 = Date.now();
    this.container.start({ entrypoint, env, enableInternet: true });
    const probes: string[] = [];
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const r = await this.run(["/bin/sh", "-c", "echo up"]);
        if (r.exitCode === 0 && r.stdout.trim() === "up") {
          return { startToExecReadyMs: Date.now() - t0, attempts, probes };
        }
        probes.push(`attempt ${attempts}: exit=${r.exitCode} out=${r.stdout.trim()}`);
      } catch (e) {
        probes.push(`attempt ${attempts}: ${String(e).slice(0, 200)}`);
      }
      if (Date.now() - t0 > budgetMs) {
        throw new Error(
          `container did not become exec-ready in ${budgetMs} ms; probes: ${probes.slice(-5).join(" | ")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Destroy and wait until the instance really is gone. `destroy()` resolves
   * before `running` goes false, and `start()` throws on a running container,
   * so the poll is required — and its duration is itself a measurement.
   */
  private async stop(budgetMs = 120_000): Promise<number> {
    const t0 = Date.now();
    if (!this.container.running) return 0;
    // monitor() is the documented "the container exited" signal; destroy()
    // resolves earlier than that, and `running` lags both.
    const exited = this.container.monitor().then(
      () => "exit",
      () => "error",
    );
    try {
      await this.container.destroy();
    } catch {
      /* not running */
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, budgetMs))]);
    while (this.container.running) {
      if (Date.now() - t0 > budgetMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return Date.now() - t0;
  }

  /**
   * start() throws while the previous instance is still shutting down, so the
   * honest measurement of "how soon can this computer wake again" is: retry
   * start() until it is accepted, then wait for the first exec.
   */
  private async startWhenAccepted(
    entrypoint: string[],
    env: Record<string, string>,
    budgetMs = 120_000,
  ): Promise<{ startAcceptedMs: number; startAttempts: number }> {
    const t0 = Date.now();
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        this.container.start({ entrypoint, env, enableInternet: true });
        return { startAcceptedMs: Date.now() - t0, startAttempts: attempts };
      } catch (e) {
        if (Date.now() - t0 > budgetMs) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!tokenOk(req.headers.get("x-probe-token"), this.env.PROBE_TOKEN)) {
      return json({ error: "forbidden" }, 403);
    }

    try {
      switch (url.pathname) {
        case "/status":
          return json({ running: this.container.running });

        case "/destroy":
          await this.stop();
          return json({ ok: true, running: this.container.running });

        /**
         * Fire-and-forget destroy: returns as soon as `destroy()` resolves, so
         * the caller can time "destroy accepted -> `running` false" from
         * outside with short requests instead of one long-held connection.
         */
        case "/destroy-async": {
          const t0 = Date.now();
          const wasRunning = this.container.running;
          let err: string | null = null;
          try {
            await this.container.destroy();
          } catch (e) {
            err = String(e);
          }
          return json({
            wasRunning,
            destroyResolvedMs: Date.now() - t0,
            runningAfter: this.container.running,
            error: err,
          });
        }

        /** Fire-and-forget start: reports whether the call was accepted. */
        case "/start-async": {
          const ep = url.searchParams.get("entrypoint") ?? "/usr/local/bin/idle.sh";
          try {
            this.container.start({ entrypoint: [ep], env: {}, enableInternet: true });
            return json({ accepted: true, running: this.container.running });
          } catch (e) {
            return json({ accepted: false, error: String(e) });
          }
        }

        /**
         * `setInactivityTimeout` is the only knob on the raw API that looks
         * like it governs how long the platform holds an instance for this
         * object. If a short timeout shortens the post-destroy window in which
         * `start()` is refused, the Cloudflare driver must call it.
         */
        case "/inactivity": {
          const ms = Number(url.searchParams.get("ms") ?? "10000");
          await this.container.setInactivityTimeout(ms);
          return json({ ok: true, ms, running: this.container.running });
        }

        /** One cheap exec: has the sandbox become usable yet? */
        case "/ping": {
          const t0 = Date.now();
          try {
            const r = await this.run(["/bin/sh", "-c", "echo up; cat /tmp/probe/t_entry"]);
            return json({ ok: r.exitCode === 0, out: r.stdout.trim(), ms: Date.now() - t0 });
          } catch (e) {
            return json({ ok: false, error: String(e), ms: Date.now() - t0 });
          }
        }

        /** Cold-start the idle image and report container-start latency. */
        case "/boot": {
          const destroyMs = await this.stop();
          const t = await this.startAndWait(["/usr/local/bin/idle.sh"], {
            MARI_PROBE: "gate1",
          });
          const entry = await this.run(["/bin/sh", "-c", "cat /tmp/probe/t_entry"]);
          return json({
            destroyToStoppedMs: destroyMs,
            ...t,
            containerClockAtEntrypointMs: Number(entry.stdout.trim()) || null,
            doClockNowMs: Date.now(),
          });
        }

        /**
         * N destroy/start cycles. Each iteration writes a marker into the
         * container's disk before the destroy and checks it is gone after the
         * next start — the platform's "all disk is ephemeral" rule (spec 2's
         * "a substrate disk is a cache") measured rather than quoted.
         */
        case "/coldcycle": {
          const n = Number(url.searchParams.get("n") ?? "3");
          const cycles: unknown[] = [];
          try {
            for (let i = 0; i < n; i++) {
              const marker = `/work/EPHEMERAL-MARKER`;
              if (this.container.running) {
                await this.run(["/bin/sh", "-c", `echo cycle${i} > ${marker}`]);
              }
              const destroyMs = await this.stop();
              const s = await this.startWhenAccepted(["/usr/local/bin/idle.sh"], {});
              const t0 = Date.now();
              let execReady: number | null = null;
              let attempts = 0;
              while (execReady === null) {
                attempts++;
                try {
                  const r = await this.run(["/bin/sh", "-c", "echo up"]);
                  if (r.exitCode === 0) execReady = Date.now() - t0;
                } catch {
                  if (Date.now() - t0 > 90_000) throw new Error("never became exec-ready");
                  await new Promise((r) => setTimeout(r, 100));
                }
              }
              const check = await this.run([
                "/bin/sh",
                "-c",
                `if [ -e ${marker} ]; then echo SURVIVED; else echo GONE; fi; ` +
                  `ls -a /work | tr '\\n' ' '`,
              ]);
              cycles.push({
                cycle: i,
                destroyToStoppedMs: destroyMs,
                startAcceptedMs: s.startAcceptedMs,
                startAttempts: s.startAttempts,
                startToExecReadyMs: execReady,
                execAttempts: attempts,
                diskCheck: check.stdout.trim(),
              });
            }
          } catch (e) {
            return json({ cycles, abortedWith: String(e) });
          }
          return json({ cycles });
        }

        /** One synchronous command. Keep it short: this blocks the response. */
        case "/exec": {
          const body = (await req.json()) as {
            argv: string[];
            cwd?: string;
            env?: Record<string, string>;
          };
          return json(await this.run(body.argv, { cwd: body.cwd, env: body.env }));
        }

        /**
         * Launch a long command detached, so the HTTP request returns at once
         * and a 100 MiB snapshot cannot hit an edge response timeout.
         */
        case "/bg": {
          const body = (await req.json()) as { name: string; cmd: string };
          const out = `/tmp/probe/${body.name}.out`;
          const rc = `/tmp/probe/${body.name}.rc`;
          const script =
            `rm -f ${out} ${rc}; ` +
            `nohup /bin/sh -c '{ ${body.cmd} ; } > ${out} 2>&1; echo $? > ${rc}' ` +
            `< /dev/null > /dev/null 2>&1 & echo launched`;
          return json(await this.run(["/bin/sh", "-c", script]));
        }

        /** Poll a /bg job. */
        case "/poll": {
          const name = url.searchParams.get("name") ?? "";
          const r = await this.run([
            "/bin/sh",
            "-c",
            `if [ -f /tmp/probe/${name}.rc ]; then echo "RC=$(cat /tmp/probe/${name}.rc)"; else echo "RC=running"; fi; ` +
              `echo "----8<----"; cat /tmp/probe/${name}.out 2>/dev/null`,
          ]);
          const [head, ...rest] = r.stdout.split("----8<----\n");
          const rcLine = head.trim().replace(/^RC=/, "");
          return json({
            name,
            done: rcLine !== "running",
            rc: rcLine === "running" ? null : Number(rcLine),
            output: rest.join("----8<----\n"),
          });
        }

        /**
         * Cold-start with marid as the entrypoint and time the whole wake:
         * container start -> marid restores MARI_RESTORE_MANIFEST into
         * MARI_ROOT -> "cold-wake restore complete".
         */
        case "/marid": {
          const manifest = url.searchParams.get("manifest");
          if (!manifest) return json({ error: "manifest query param required" }, 400);
          await this.stop();
          const t0 = Date.now();
          this.container.start({
            entrypoint: ["/usr/local/bin/probe-boot.sh"],
            enableInternet: true,
            env: {
              MARI_COMPUTER_ID: "gate1-probe",
              MARI_CONTROL_URL: "ws://127.0.0.1:9/supervisor",
              MARI_TOKEN: "unused-in-gate1",
              MARI_EPOCH: "1",
              MARI_ROOT: "/work",
              MARI_STORE: "fs:///store",
              MARI_RESTORE_MANIFEST: manifest,
              RUST_LOG: "info,marid=debug",
            },
          });

          let execReadyMs: number | null = null;
          let restoredMs: number | null = null;
          const budget = 120_000;
          for (;;) {
            try {
              const r = await this.run([
                "/bin/sh",
                "-c",
                "cat /tmp/probe/t_entry 2>/dev/null; echo '|'; cat /tmp/probe/t_restored 2>/dev/null",
              ]);
              if (r.exitCode === 0) {
                if (execReadyMs === null) execReadyMs = Date.now() - t0;
                const [entry, restored] = r.stdout.split("|");
                if (restored && restored.trim()) {
                  restoredMs = Date.now() - t0;
                  const log = await this.run([
                    "/bin/sh",
                    "-c",
                    "cat /tmp/probe/marid.log; echo '--- tree ---'; ls -la /work; " +
                      "echo '--- t ---'; cat /tmp/probe/t_entry; echo; cat /tmp/probe/t_restored",
                  ]);
                  return json({
                    manifest,
                    startToExecReadyMs: execReadyMs,
                    startToRestoreCompleteMs: restoredMs,
                    containerEntryClockMs: Number(entry.trim()) || null,
                    containerRestoredClockMs: Number(restored.trim()) || null,
                    inContainerEntryToRestoreMs:
                      Number(restored.trim()) - Number(entry.trim()) || null,
                    log: log.stdout,
                  });
                }
              }
            } catch (e) {
              if (Date.now() - t0 > budget) throw e;
            }
            if (Date.now() - t0 > budget) {
              const log = await this.run([
                "/bin/sh",
                "-c",
                "cat /tmp/probe/marid.log 2>/dev/null; ls -la /work 2>&1",
              ]).catch((e) => ({ stdout: String(e) }) as any);
              return json(
                {
                  manifest,
                  startToExecReadyMs: execReadyMs,
                  startToRestoreCompleteMs: null,
                  error: "marid did not report a cold-wake restore within budget",
                  log: log.stdout,
                },
                504,
              );
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        default:
          return json({ error: "no such route", path: url.pathname }, 404);
      }
    } catch (e) {
      return json({ error: String(e), stack: (e as Error)?.stack ?? null }, 500);
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!tokenOk(req.headers.get("x-probe-token"), env.PROBE_TOKEN)) {
      return json({ error: "forbidden" }, 403);
    }
    // One container, one object: exactly the shape ComputerDO would have.
    // `?id=` picks a different object, so a fresh instance can be compared
    // against one whose container was just destroyed.
    const name = new URL(req.url).searchParams.get("id") ?? "gate1";
    const stub = env.PROBE.get(env.PROBE.idFromName(name));
    return stub.fetch(req);
  },
};
