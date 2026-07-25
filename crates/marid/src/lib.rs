//! `marid` — the Mari supervisor daemon (spec §5). It owns every run on an
//! AWAKE computer: it snapshots the filesystem before each run, spawns the
//! command on a real PTY, streams the journal to the control plane over framed
//! CBOR/WebSocket, detects content-free attention signals, schedules snapshots,
//! and drives the WARM->COLD shutdown.
//!
//! The library exposes the components so they can be tested with teeth and
//! reused by the e2e suite; [`run`] is the daemon entry point.

pub mod adapters;
pub mod attention;
pub mod config;
pub(crate) mod continuation;
pub mod journal;
pub mod run;
pub mod state;
pub mod store_uri;
pub mod supervisor;
pub mod ws;

/// Reusable fake control-plane server for tests and the e2e suite. Available to
/// in-crate tests always, and to external crates via the `test-support` feature.
#[cfg(any(test, feature = "test-support"))]
pub mod testkit;

pub use config::Config;
pub use supervisor::run;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_continuation;

#[cfg(test)]
mod tests_keepalive;
