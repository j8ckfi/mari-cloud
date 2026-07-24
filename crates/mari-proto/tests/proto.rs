//! Behavioural tests for encoding, framing, and the incremental reader.

use mari_proto::{
    ControlMessage, Epoch, FrameReader, JournalOffset, MAX_FRAME_LEN, RunId, SupervisorMessage,
    decode_frame, encode_frame, frame::Error,
};

fn sample_journal(offset: u64) -> SupervisorMessage {
    SupervisorMessage::JournalFrame {
        run: RunId::new("run-0001"),
        offset: JournalOffset::new(offset),
        // Include control bytes and a NUL to prove raw byte fidelity.
        bytes: vec![0x00, 0x1b, b'[', b'0', b'm', b'\n', 0xff],
    }
}

#[test]
fn frame_has_big_endian_u32_prefix() {
    let msg = SupervisorMessage::RunHeartbeat {
        run: RunId::new("r"),
    };
    let framed = encode_frame(&msg).unwrap();
    let body_len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
    assert_eq!(body_len, framed.len() - 4, "prefix must equal body length");
    // Round-trips through decode_frame.
    let back: SupervisorMessage = decode_frame(&framed).unwrap();
    assert_eq!(back, msg);
}

#[test]
fn every_message_round_trips_through_a_frame() {
    let messages: Vec<SupervisorMessage> = vec![
        sample_journal(0),
        sample_journal(1 << 40), // large-but-JS-safe offset
        SupervisorMessage::RunHeartbeat {
            run: RunId::new("run-0001"),
        },
    ];
    for msg in messages {
        let framed = encode_frame(&msg).unwrap();
        let back: SupervisorMessage = decode_frame(&framed).unwrap();
        assert_eq!(back, msg);
    }

    // Control-plane -> supervisor, including the first-class terminal
    // input/resize messages.
    let control: Vec<ControlMessage> = vec![
        ControlMessage::Input {
            run: RunId::new("run-0001"),
            bytes: b"echo hi\r".to_vec(),
        },
        ControlMessage::Resize {
            run: RunId::new("run-0001"),
            cols: 200,
            rows: 50,
        },
        ControlMessage::JournalAck {
            run: RunId::new("run-0001"),
            offset: JournalOffset::new(1 << 40),
        },
    ];
    for msg in control {
        let framed = encode_frame(&msg).unwrap();
        let back: ControlMessage = decode_frame(&framed).unwrap();
        assert_eq!(back, msg);
    }
}

#[test]
fn reader_reassembles_frames_split_across_arbitrary_boundaries() {
    // Concatenate three frames, then feed the stream one byte at a time.
    let originals = [sample_journal(0), sample_journal(64), sample_journal(4096)];
    let mut stream = Vec::new();
    for m in &originals {
        stream.extend_from_slice(&encode_frame(m).unwrap());
    }

    let mut reader = FrameReader::new();
    let mut decoded: Vec<SupervisorMessage> = Vec::new();
    for byte in &stream {
        reader.push(std::slice::from_ref(byte));
        while let Some(msg) = reader.next::<SupervisorMessage>().unwrap() {
            decoded.push(msg);
        }
    }
    assert_eq!(decoded.len(), originals.len());
    assert_eq!(decoded, originals.to_vec());
    assert_eq!(reader.buffered(), 0, "no trailing bytes left buffered");
}

#[test]
fn reader_yields_none_until_a_full_frame_arrives() {
    let framed = encode_frame(&ControlMessage::PrepareForCold).unwrap();
    let mut reader = FrameReader::new();
    // Push everything but the last byte: still incomplete.
    reader.push(&framed[..framed.len() - 1]);
    assert!(reader.next::<ControlMessage>().unwrap().is_none());
    // Final byte completes it.
    reader.push(&framed[framed.len() - 1..]);
    let msg: ControlMessage = reader.next().unwrap().unwrap();
    assert_eq!(msg, ControlMessage::PrepareForCold);
}

#[test]
fn oversized_declared_length_is_rejected_before_allocation() {
    // A crafted prefix claiming a body larger than MAX_FRAME_LEN, with no body.
    let mut framed = Vec::new();
    framed.extend_from_slice(&(MAX_FRAME_LEN + 1).to_be_bytes());
    let err = decode_frame::<ControlMessage>(&framed).unwrap_err();
    assert!(matches!(err, Error::FrameTooLarge { .. }));

    let mut reader = FrameReader::new();
    reader.push(&framed);
    let err = reader.next::<ControlMessage>().unwrap_err();
    assert!(matches!(err, Error::FrameTooLarge { .. }));
}

#[test]
fn truncated_frame_is_reported() {
    let err = decode_frame::<ControlMessage>(&[0, 0]).unwrap_err();
    assert!(matches!(err, Error::Truncated { .. }));
}

#[test]
fn adjacent_tagging_shape_is_stable() {
    // The envelope must serialize as { "t": <variant>, "c": <payload> }.
    let msg = SupervisorMessage::RunHeartbeat {
        run: RunId::new("run-xyz"),
    };
    let value: ciborium::value::Value = {
        let bytes = mari_proto::to_cbor(&msg).unwrap();
        mari_proto::from_cbor(&bytes).unwrap()
    };
    let map = value.as_map().expect("envelope is a map");
    let keys: Vec<&str> = map
        .iter()
        .filter_map(|(k, _)| k.as_text())
        .collect();
    assert_eq!(keys, vec!["t", "c"], "keys are t then c, in order");
    let tag = map[0].1.as_text().unwrap();
    assert_eq!(tag, "run_heartbeat");
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "safe-integer")]
fn epoch_beyond_js_safe_integer_panics_in_debug() {
    // 2^53 is one past MAX_SAFE_INTEGER; serializing it trips the debug assert.
    let _ = mari_proto::to_cbor(&Epoch::new(9_007_199_254_740_992));
}
