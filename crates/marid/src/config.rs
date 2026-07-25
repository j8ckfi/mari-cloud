//! Supervisor configuration, from environment and flags (clap).
//!
//! Every value has an env fallback so `marid` can run as a container entrypoint
//! with a plain environment, and every value can also be overridden by a flag
//! for local runs. The struct is `Clone` and publicly constructible so tests can
//! build a config without going through argument parsing.

use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;

/// Runtime configuration for the supervisor daemon.
#[derive(Clone, Debug, Parser)]
#[command(name = "marid", about = "The Mari supervisor daemon")]
pub struct Config {
    /// Stable computer identity this supervisor serves.
    #[arg(long, env = "MARI_COMPUTER_ID")]
    pub computer_id: String,

    /// WebSocket URL of the control plane: `wss://host/path`, or `ws://host/path`
    /// when the host is loopback/private (see `allow_insecure_ws`).
    #[arg(long, env = "MARI_CONTROL_URL")]
    pub control_url: String,

    /// Permit a plaintext `ws://` control URL to a host that is NOT loopback or
    /// private. Off by default: the `Hello` carries this computer's wake token
    /// and every journal byte follows it, so a public origin must not be
    /// downgraded to cleartext by a config mistake. Set this only when TLS is
    /// terminated by something you trust in front of the control plane.
    ///
    /// A flag with no value (`--allow-insecure-ws`), and a *falsey-parsed*
    /// environment variable: `MARI_ALLOW_INSECURE_WS=1` / `true` / `yes` / `on`
    /// enable it, `0` / `false` / empty do not. The explicit action and parser are
    /// load-bearing: clap's derive gives a `bool` field a strict bool parser, so
    /// the plain form rejects `MARI_ALLOW_INSECURE_WS=1` — which is exactly how a
    /// container sets a boolean.
    #[arg(
        long,
        env = "MARI_ALLOW_INSECURE_WS",
        action = clap::ArgAction::SetTrue,
        value_parser = clap::builder::FalseyValueParser::new()
    )]
    pub allow_insecure_ws: bool,

    /// Opaque bearer token issued by the control plane at wake.
    #[arg(long, env = "MARI_TOKEN", default_value = "")]
    pub token: String,

    /// Fencing epoch minted by the Durable Object for this wake.
    #[arg(long, env = "MARI_EPOCH", default_value_t = 1)]
    pub epoch: u64,

    /// Root of the computer filesystem this supervisor snapshots/restores.
    #[arg(long, env = "MARI_ROOT")]
    pub root: PathBuf,

    /// Chunk store URI: `fs:///abs/path` or `s3://bucket/root` (s3 feature).
    #[arg(long, env = "MARI_STORE")]
    pub store: String,

    /// Seconds between scheduled snapshots.
    #[arg(long, env = "MARI_SNAPSHOT_INTERVAL", default_value_t = 300)]
    pub snapshot_interval_secs: u64,

    /// Milliseconds of PTY silence (child alive, stdin open) before a
    /// blocked-read attention event fires.
    #[arg(long, env = "MARI_ATTENTION_SILENCE_MS", default_value_t = 30_000)]
    pub attention_silence_ms: u64,

    /// If set, restore this manifest into `root` before connecting (cold wake).
    #[arg(long, env = "MARI_RESTORE_MANIFEST")]
    pub restore_manifest: Option<String>,

    /// Directory of declarative agent adapters (`*.toml`, spec 5.6). A missing
    /// directory is not an error: the computer then simply has no agent that
    /// declares a resume function.
    #[arg(long, env = "MARI_AGENTS_DIR", default_value = "/etc/mari/agents.d")]
    pub agents_dir: PathBuf,

    /// Journal segment size in bytes; a segment is uploaded once it reaches this.
    #[arg(long, env = "MARI_SEGMENT_BYTES", default_value_t = 4 * 1024 * 1024)]
    pub segment_bytes: u64,

    /// Milliseconds between supervisor-level WebSocket keepalive pings. This is
    /// **not** the per-run hold of spec 5.4: it exists whether or not a run is
    /// active, because an AWAKE computer with no run still needs its control
    /// channel. Idle WebSockets through the edge are killed at ~270 s (measured,
    /// 1006 with no close frame), so the default sits well under that. 0 disables.
    #[arg(long, env = "MARI_KEEPALIVE_MS", default_value_t = 60_000)]
    pub keepalive_ms: u64,

    /// Milliseconds without a single inbound frame — not even a pong to our
    /// keepalive — after which the control socket is treated as dead and
    /// reconnected. This is the silent-death case: a flow dropped by a NAT with
    /// no RST leaves reads hanging forever, and the supervisor would be offline
    /// with no error to show for it. 0 disables.
    #[arg(long, env = "MARI_IDLE_TIMEOUT_MS", default_value_t = 240_000)]
    pub idle_timeout_ms: u64,

    /// Total milliseconds the graceful-shutdown sequence (SIGTERM/SIGINT) may
    /// take: stop each run, flush journal segments, write the final manifest,
    /// advance the head. Substrates give a bounded eviction window — Cloudflare
    /// Containers send SIGTERM with ~15 minutes — and a stuck run must not eat
    /// it, so the run-stop phase gets a fraction of this budget and the manifest
    /// write gets the rest.
    #[arg(long, env = "MARI_SHUTDOWN_GRACE_MS", default_value_t = 60_000)]
    pub shutdown_grace_ms: u64,
}

impl Config {
    /// The silence threshold as a [`Duration`].
    pub fn silence_threshold(&self) -> Duration {
        Duration::from_millis(self.attention_silence_ms)
    }

    /// The scheduled-snapshot interval as a [`Duration`].
    pub fn snapshot_interval(&self) -> Duration {
        Duration::from_secs(self.snapshot_interval_secs)
    }

    /// The supervisor-level keepalive interval, or `None` when disabled.
    pub fn keepalive_interval(&self) -> Option<Duration> {
        (self.keepalive_ms > 0).then(|| Duration::from_millis(self.keepalive_ms))
    }

    /// How long the control socket may go without any inbound frame before it is
    /// declared dead, or `None` when disabled.
    pub fn idle_timeout(&self) -> Option<Duration> {
        (self.idle_timeout_ms > 0).then(|| Duration::from_millis(self.idle_timeout_ms))
    }

    /// The total graceful-shutdown budget.
    pub fn shutdown_grace(&self) -> Duration {
        Duration::from_millis(self.shutdown_grace_ms)
    }

    /// How long the shutdown may spend stopping runs before it writes the final
    /// manifest anyway: a third of the budget, so two thirds are left for the
    /// snapshot, the segment uploads and the head advance.
    ///
    /// The 10 s ceiling is not arbitrary. `PrepareForCold` runs this same
    /// sequence, and the Durable Object gives that handshake a deadline
    /// (`COLD_FINALIZE_MS`, 20 s by default) after which it records
    /// `final_snapshot_missed` and destroys the substrate resources anyway. A
    /// stop phase that could run for the whole of that window would turn one
    /// stubborn run into a computer that goes COLD with no final manifest, so the
    /// stop never gets more than half of it. The floor keeps a tiny configured
    /// grace from denying runs any chance to stop cleanly at all.
    pub fn shutdown_stop_budget(&self) -> Duration {
        (self.shutdown_grace() / 3).clamp(Duration::from_millis(200), Duration::from_secs(10))
    }

    /// Parse from process arguments and the environment.
    pub fn from_args() -> Self {
        Config::parse()
    }
}
