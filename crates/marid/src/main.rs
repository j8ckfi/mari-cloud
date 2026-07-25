//! marid — the Mari supervisor. Owns all runs on an AWAKE computer.

use marid::Config;
use tracing::error;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let config = Config::from_args();
    let result = marid::run(config).await;

    // Exit deliberately instead of falling out of `main`.
    //
    // Every run's PTY is drained by a `spawn_blocking` thread parked in a
    // blocking `read()`, and tokio's runtime drop WAITS for blocking tasks that
    // have already started. A run that ignored the clean stop (spec 4.5) still
    // holds its pty open, so returning normally would hang the process forever —
    // after a shutdown that already did all of its durable work. On a substrate
    // whose eviction window is finite, "the manifest is written but the process
    // will not die" is indistinguishable from a hang.
    //
    // Nothing is lost by exiting here: the final manifest, the journal segments
    // and the recorded head are all in the chunk store before `run` returns.
    match result {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            error!("marid exiting: {e:#}");
            std::process::exit(1);
        }
    }
}
