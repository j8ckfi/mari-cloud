//! Regression test (was review repro): terminal INPUT/RESIZE now reach the
//! supervisor as first-class `ControlMessage` variants.
//!
//! The web client sends `input` / `resize` over the client<->DO attach protocol
//! (contracts §7.1). The Durable Object forwards them supervisor-ward as framed
//! CBOR `ControlMessage::Input { run, bytes }` and `ControlMessage::Resize {
//! run, cols, rows }`. Before formalization these rode ad-hoc `{t:"input"}` /
//! `{t:"client_resize"}` frames that `mari_proto::ControlMessage` could not
//! decode, so a single keystroke made the supervisor read loop error and tear
//! down the session (spec 5.1 violated). This test proves the frames now decode
//! and flow through the same read path the supervisor uses.

use mari_proto::{ControlMessage, FrameReader, RunId, encode_frame};

fn frame(cm: &ControlMessage) -> Vec<u8> {
    encode_frame(cm).expect("encode frame")
}

#[test]
fn input_frame_decodes_into_control_message_input() {
    let cm = ControlMessage::Input {
        run: RunId::new("run-0001"),
        bytes: b"ls -la\r".to_vec(),
    };
    let decoded = mari_proto::from_cbor::<ControlMessage>(&mari_proto::to_cbor(&cm).unwrap())
        .expect("input must decode as a ControlMessage");
    match decoded {
        ControlMessage::Input { run, bytes } => {
            assert_eq!(run, RunId::new("run-0001"));
            assert_eq!(bytes, b"ls -la\r");
        }
        other => panic!("expected ControlMessage::Input, got {other:?}"),
    }
}

#[test]
fn resize_frame_decodes_into_control_message_resize() {
    let cm = ControlMessage::Resize {
        run: RunId::new("run-0001"),
        cols: 120,
        rows: 40,
    };
    let decoded = mari_proto::from_cbor::<ControlMessage>(&mari_proto::to_cbor(&cm).unwrap())
        .expect("resize must decode as a ControlMessage");
    assert!(matches!(
        decoded,
        ControlMessage::Resize {
            cols: 120,
            rows: 40,
            ..
        }
    ));
}

#[test]
fn supervisor_read_loop_surfaces_input_and_resize_without_tearing_down() {
    // Exactly what supervisor.rs `connect_and_serve` does with an incoming binary
    // message: `decode_payload(&mut frames, payload, &mut msgs)?`. A pre-fix
    // `input` frame returned Err here and dropped the session; now both frames
    // decode and are surfaced to the supervisor.
    let mut reader = FrameReader::new();
    let mut out: Vec<ControlMessage> = Vec::new();

    let input = frame(&ControlMessage::Input {
        run: RunId::new("run-0001"),
        bytes: b"x".to_vec(),
    });
    let resize = frame(&ControlMessage::Resize {
        run: RunId::new("run-0001"),
        cols: 80,
        rows: 24,
    });
    let mut payload = input;
    payload.extend_from_slice(&resize);

    marid::ws::decode_payload(&mut reader, &payload, &mut out)
        .expect("first-class input/resize frames must decode, not tear down the session");
    assert_eq!(out.len(), 2, "both control messages surfaced to the supervisor");
    assert!(matches!(out[0], ControlMessage::Input { .. }));
    assert!(matches!(out[1], ControlMessage::Resize { .. }));
}

#[test]
fn stale_client_resize_tag_is_no_longer_a_variant() {
    // The ad-hoc `client_resize` shape is gone: `ControlMessage` has no such
    // variant, so a frame carrying that tag fails to decode. (Nothing produces
    // it anymore; this guards against a regression that reintroduces it.)
    // { "t": "client_resize", "c": null }
    let body: &[u8] = &[
        0xA2, 0x61, b't', 0x6D, b'c', b'l', b'i', b'e', b'n', b't', b'_', b'r', b'e', b's', b'i',
        b'z', b'e', 0x61, b'c', 0xF6,
    ];
    assert!(
        mari_proto::from_cbor::<ControlMessage>(body).is_err(),
        "the ad-hoc client_resize tag must not decode as a ControlMessage"
    );
}
