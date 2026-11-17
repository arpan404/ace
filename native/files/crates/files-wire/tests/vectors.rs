// SPDX-License-Identifier: Apache-2.0

// Test-only code: panicking on a broken fixture or frame is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! The golden vectors in `native/files/vectors` are the contract the TypeScript client is tested
//! against too, so every one of them must decode, re-encode and mean the same thing. A JSON vector
//! also records the exact payload text, so a field that quietly changes shape fails here even when
//! the value it carries still parses.

use std::fs;
use std::path::{Path, PathBuf};

use files_wire::{Decoder, Frame, Message, encode, encode_body};
use serde_json::Value;

fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vectors")
}

fn unhex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0, "hex has whole bytes");
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).expect("hex is ascii");
            u8::from_str_radix(text, 16).expect("hex digits")
        })
        .collect()
}

fn vector_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(vectors_dir())
        .expect("vectors folder")
        .map(|entry| entry.expect("readable entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
}

/// Read a field a vector must carry.
fn field<'a>(document: &'a Value, name: &str, key: &str) -> &'a Value {
    document
        .get(key)
        .unwrap_or_else(|| panic!("{name} has a {key} field"))
}

/// Check the frame's own length prefix against the bytes that follow it.
fn check_length(name: &str, frame: &[u8]) {
    let mut header = [0u8; 4];
    header.copy_from_slice(&frame[..4]);
    assert_eq!(
        u32::from_le_bytes(header) as usize,
        frame.len() - 4,
        "{name} declares the bytes it carries"
    );
}

#[test]
fn every_vector_round_trips() {
    let files = vector_files();
    assert!(!files.is_empty(), "the vectors folder holds golden frames");

    for path in files {
        let name = path
            .file_name()
            .expect("a file name")
            .to_string_lossy()
            .into_owned();
        let text = fs::read_to_string(&path).expect("vector is readable");
        let document: Value = serde_json::from_str(&text).expect("vector is JSON");
        let json = field(&document, &name, "json");
        let frame = unhex(
            field(&document, &name, "frame")
                .as_str()
                .unwrap_or_else(|| panic!("{name} records its frame as hex")),
        );
        check_length(&name, &frame);

        match frame[4] {
            1 => {
                let payload = field(&document, &name, "text")
                    .as_str()
                    .unwrap_or_else(|| panic!("{name} records its payload text"));
                assert_eq!(
                    &frame[5..],
                    payload.as_bytes(),
                    "{name} carries exactly its recorded text"
                );

                let message: Message = serde_json::from_value(json.clone())
                    .unwrap_or_else(|error| panic!("{name} does not parse: {error}"));
                assert_eq!(
                    serde_json::to_value(&message).expect("a message serializes"),
                    *json,
                    "{name} keeps its fields"
                );
                assert_eq!(
                    encode(&message)
                        .unwrap_or_else(|error| panic!("{name} does not encode: {error}")),
                    frame,
                    "{name} encodes to its recorded frame"
                );

                let mut decoder = Decoder::new();
                decoder.push(&frame);
                let decoded = decoder
                    .poll()
                    .unwrap_or_else(|error| panic!("{name} does not decode: {error}"))
                    .unwrap_or_else(|| panic!("{name} is not a whole frame"));
                assert_eq!(decoded, Frame::Message(message), "{name} decodes back");
                assert_eq!(
                    decoder.poll().expect("no frame error"),
                    None,
                    "{name} is exactly one frame"
                );
                let Frame::Message(decoded) = decoded else {
                    panic!("{name} is not a message frame");
                };
                assert_eq!(
                    encode(&decoded).expect("a decoded message re-encodes"),
                    frame,
                    "{name} re-encodes byte for byte"
                );
            }
            2 => {
                assert!(
                    document.get("text").is_none(),
                    "{name} is binary and has no payload text"
                );
                let id = field(&document, &name, "json")
                    .get("id")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(|| panic!("{name} records a request id"));
                let bytes = unhex(
                    field(&document, &name, "json")
                        .get("bytes")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| panic!("{name} records its bytes as hex")),
                );
                assert_eq!(
                    encode_body(id, &bytes)
                        .unwrap_or_else(|error| panic!("{name} does not encode: {error}")),
                    frame,
                    "{name} encodes to its recorded frame"
                );

                let mut decoder = Decoder::new();
                decoder.push(&frame);
                assert_eq!(
                    decoder.poll().expect("a body frame decodes"),
                    Some(Frame::Body {
                        id,
                        bytes: bytes.clone()
                    }),
                    "{name} carries its id and bytes"
                );
                assert_eq!(decoder.poll().expect("no frame error"), None);
            }
            other => panic!("{name} has an unexpected frame kind {other}"),
        }
    }
}
