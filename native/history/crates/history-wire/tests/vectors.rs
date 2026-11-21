// SPDX-License-Identifier: Apache-2.0

//! The frames in `vectors/wire.json` come from the TypeScript side (ADR 0206): this side must
//! read what the daemon writes and write, byte for byte, what the daemon reads.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use history_wire::{Decoder, Frame, Inbound, Request, encode_body, encode_json, take_body_index};
use serde_json::Value;

fn vectors() -> Value {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../vectors/wire.json"
    ))
    .expect("vectors");
    serde_json::from_str(&text).expect("json")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_all(frames: &Value) -> Vec<Frame> {
    let mut decoder = Decoder::new();
    for frame in frames.as_array().expect("frames") {
        // Split every frame in two to exercise partial reads.
        let bytes = unhex(frame.as_str().expect("hex"));
        let (a, b) = bytes.split_at(bytes.len() / 2);
        decoder.push(a);
        decoder.push(b);
    }
    let mut out = Vec::new();
    while let Some(frame) = decoder.poll().expect("frame") {
        out.push(frame);
    }
    out
}

#[test]
fn the_reader_reads_every_daemon_message_as_the_worker_did() {
    for case in vectors()["toReader"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let frames = decode_all(&case["frames"]);
        let bodies: Vec<&Vec<u8>> = frames
            .iter()
            .filter_map(|f| match f {
                Frame::Body { bytes, .. } => Some(bytes),
                Frame::Json(_) => None,
            })
            .collect();
        let Some(Frame::Json(text)) = frames.last() else {
            panic!("{name}: no json")
        };
        let parsed = Inbound::parse(text);
        let expected = &case["message"];
        match (name, parsed) {
            ("init", Inbound::Init(options)) => assert_eq!(&options, &expected["init"]),
            ("cancel", Inbound::Cancel) => {}
            (
                "scan",
                Inbound::Envelope {
                    id: 1,
                    request: Ok(Request::Scan),
                },
            ) => {}
            (
                "list",
                Inbound::Envelope {
                    id: 2,
                    request: Ok(Request::List { request, exclude }),
                },
            ) => {
                assert_eq!(request.cwd, "/w");
                assert_eq!(request.before.expect("before").last_activity, 5);
                assert_eq!(exclude, vec!["claude:x".to_owned()]);
            }
            (
                "blob-chunk",
                Inbound::Envelope {
                    id: 3,
                    request: Ok(Request::ArchiveWrite { command }),
                },
            ) => {
                let history_wire::ArchiveCommand::BlobChunk { bytes, .. } = command else {
                    panic!("blob-chunk: wrong command")
                };
                let index = take_body_index(&bytes).expect("body ref");
                assert_eq!(
                    hex(bodies[index]),
                    expected["request"]["command"]["bytes"]
                        .as_str()
                        .expect("hex")
                );
            }
            (
                "import",
                Inbound::Envelope {
                    id: 4,
                    request: Ok(Request::Import { init }),
                },
            ) => {
                assert_eq!(init.source_id, "s");
                assert_eq!(init.at, 7);
            }
            (name, other) => panic!("{name}: read as {other:?}"),
        }
    }
}

#[test]
fn the_reader_writes_the_frames_the_daemon_reads() {
    for case in vectors()["fromReader"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let expected: Vec<&str> = case["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .map(|f| f.as_str().expect("hex"))
            .collect();
        let mut message = case["message"].clone();
        let mut written = Vec::new();
        if name == "blob-reply" {
            let bytes = unhex(message["value"]["bytes"].as_str().expect("hex"));
            written.push(hex(&encode_body(9, &bytes).expect("body")));
            message["value"]["bytes"] = history_wire::body_ref(0);
        }
        written.push(hex(&encode_json(&message).expect("json")));
        assert_eq!(written, expected, "{name}");
    }
}

#[test]
fn an_unknown_op_is_named_not_fatal() {
    let parsed = Inbound::parse(br#"{"id":3,"request":{"op":"archive.future"}}"#);
    assert_eq!(
        parsed,
        Inbound::Envelope {
            id: 3,
            request: Err("archive.future".to_owned())
        }
    );
}

#[test]
fn an_oversize_declaration_ends_the_stream() {
    let mut decoder = Decoder::new();
    decoder.push(&(history_wire::MAX_FRAME_LEN + 1).to_le_bytes());
    assert!(decoder.poll().is_err());
    decoder.push(&encode_json(&Value::Null).expect("json"));
    assert!(decoder.poll().is_err());
}
