//! The control-URL scheme policy, enforced by the real binary.
//!
//! `ws::classify_control_url` is unit-tested in the library; what this file adds
//! is the part only a process can show: a supervisor pointed at a **public**
//! origin over plaintext `ws://` refuses to start, says why on stderr, and exits
//! non-zero — rather than dialing and putting the computer's wake token, and then
//! every journal byte of every run, on the wire in cleartext.
//!
//! It also pins the escape hatch, because a policy with no documented override is
//! a policy someone will patch out: `MARI_ALLOW_INSECURE_WS=1` is accepted, and
//! the daemon says out loud what that costs.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Run `marid` with the given control URL and environment additions, wait for it
/// to exit (or give up), and return `(exited, code, stderr)`.
fn run_marid(
    control_url: &str,
    extra: &[(&str, &str)],
    wait: Duration,
) -> (bool, Option<i32>, String) {
    let root = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_marid"));
    cmd.env("MARI_COMPUTER_ID", "comp-policy")
        .env("MARI_CONTROL_URL", control_url)
        .env("MARI_TOKEN", "policy-token")
        .env("MARI_EPOCH", "1")
        .env("MARI_ROOT", root.path())
        .env("MARI_STORE", format!("fs://{}", store.path().display()))
        .env("MARI_SNAPSHOT_INTERVAL", "3600")
        .env("RUST_LOG", "info")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn marid");

    let deadline = Instant::now() + wait;
    let status = loop {
        match child.try_wait().expect("try_wait") {
            Some(s) => break Some(s),
            None if Instant::now() >= deadline => break None,
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    if status.is_none() {
        let _ = child.kill();
    }
    let out = child.wait_with_output().expect("collect output");
    (
        status.is_some(),
        status.and_then(|s| s.code()),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// A public host over plaintext must stop the daemon before it dials.
///
/// Only IP literals here, deliberately: they are classified with no resolver at
/// all, so this test says the same thing on a machine with no DNS as on one with
/// it. The name-based rule ("one public answer refuses the dial") is asserted
/// hermetically against exact address lists in the library's own tests
/// (`ws::tests::a_name_resolving_to_any_public_address_is_refused`), because a
/// test that depends on what a real resolver says about a real domain is a test
/// that fails for reasons other than the code.
#[test]
fn a_public_plaintext_control_url_refuses_to_start_and_exits_nonzero() {
    // TEST-NET-1 (RFC 5737) and a public IPv6 literal: routable-looking, public,
    // and never actually reachable — so nothing can be dialed even if the policy
    // somehow let it through.
    for url in [
        "ws://192.0.2.1:8787/supervisor/comp-policy",
        "ws://[2001:db8::1]:8787/supervisor/comp-policy",
    ] {
        let (exited, code, stderr) = run_marid(url, &[], Duration::from_secs(30));
        assert!(
            exited,
            "marid must refuse to start for {url} instead of running: {stderr}"
        );
        assert_eq!(
            code,
            Some(1),
            "a refused control URL must exit non-zero ({url}): {stderr}"
        );
        assert!(
            stderr.contains("cleartext"),
            "the refusal must explain itself ({url}): {stderr}"
        );
        assert!(
            stderr.contains("MARI_ALLOW_INSECURE_WS"),
            "the refusal must name the override it is not taking ({url}): {stderr}"
        );
        // And it must have refused BEFORE reaching the wire: no Hello, no dial.
        assert!(
            !stderr.contains("connected to control plane"),
            "marid dialed a URL it should have refused ({url}): {stderr}"
        );
    }
}

/// The escape hatch works, and is loud. The URL here cannot connect (TEST-NET-1),
/// so the daemon stays up retrying — which is the point: it accepted the URL.
#[test]
fn the_opt_in_lets_a_public_plaintext_url_through_and_says_what_it_costs() {
    let (exited, _code, stderr) = run_marid(
        "ws://192.0.2.1:8787/supervisor/comp-policy",
        &[("MARI_ALLOW_INSECURE_WS", "1")],
        // Long enough for the startup check, the first dial and one retry.
        Duration::from_secs(3),
    );
    assert!(
        !exited,
        "with the opt-in set, marid must accept the URL and keep running: {stderr}"
    );
    assert!(
        stderr.contains("PlainOptIn"),
        "the accepted policy must be recorded in the log: {stderr}"
    );
    assert!(
        !stderr.contains("refusing to dial"),
        "the opt-in must not still refuse: {stderr}"
    );
}

/// The opt-in is a switch, not a presence check: a falsey value must leave the
/// policy in force. `MARI_ALLOW_INSECURE_WS=0` reading as "yes" is the kind of
/// bug that turns a safety default into a coin flip.
#[test]
fn a_falsey_opt_in_value_does_not_open_cleartext() {
    for value in ["0", "false", ""] {
        let (exited, code, stderr) = run_marid(
            "ws://192.0.2.1:8787/supervisor/comp-policy",
            &[("MARI_ALLOW_INSECURE_WS", value)],
            Duration::from_secs(30),
        );
        assert!(
            exited && code == Some(1),
            "MARI_ALLOW_INSECURE_WS={value:?} must NOT enable cleartext: {stderr}"
        );
        assert!(stderr.contains("cleartext"), "{value:?}: {stderr}");
    }
}

/// A `wss://` URL must be accepted on sight — no resolver, no exception. This is
/// the case that could not work at all before TLS was compiled in: it used to
/// fail with `Url(TlsFeatureNotEnabled)` on the first dial, forever.
#[test]
fn a_wss_url_is_accepted_and_never_fails_for_want_of_tls() {
    // example.invalid never resolves, so the dial fails — but it must fail at DNS
    // or TCP, never because TLS is missing, and the daemon must stay up retrying.
    let (exited, _code, stderr) = run_marid(
        "wss://example.invalid/supervisor/comp-policy",
        &[],
        Duration::from_secs(3),
    );
    assert!(
        !exited,
        "a wss URL must be accepted and retried, not fatal: {stderr}"
    );
    assert!(
        stderr.contains("control URL accepted") && stderr.contains("Tls"),
        "the log must record that the URL was accepted as TLS: {stderr}"
    );
    assert!(
        !stderr.contains("TLS support not compiled in"),
        "TLS must be compiled in: {stderr}"
    );
}

/// A scheme that is not ws/wss is a configuration error, not something to retry.
#[test]
fn a_non_websocket_scheme_is_fatal() {
    let (exited, code, stderr) = run_marid(
        "https://app.mari.sh/supervisor/comp-policy",
        &[],
        Duration::from_secs(30),
    );
    assert!(exited, "an unsupported scheme must not start: {stderr}");
    assert_eq!(code, Some(1), "{stderr}");
    assert!(
        stderr.contains("unsupported scheme"),
        "the refusal must name the problem: {stderr}"
    );
}
