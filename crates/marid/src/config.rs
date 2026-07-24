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

    /// WebSocket URL of the control plane (e.g. `ws://host:port/path`).
    #[arg(long, env = "MARI_CONTROL_URL")]
    pub control_url: String,

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

    /// Journal segment size in bytes; a segment is uploaded once it reaches this.
    #[arg(long, env = "MARI_SEGMENT_BYTES", default_value_t = 4 * 1024 * 1024)]
    pub segment_bytes: u64,
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

    /// Parse from process arguments and the environment.
    pub fn from_args() -> Self {
        Config::parse()
    }
}
