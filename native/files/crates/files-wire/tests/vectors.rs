// SPDX-License-Identifier: Apache-2.0

// Test-only code: panicking on a broken fixture or frame is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! The golden vectors in `native/files/vectors` are the contract the TypeScript client is tested
//! against too, so every one of them must decode, re-encode and mean the same thing.

use std::fs;
use std::path::{Path, PathBuf};

use files_wire::{Decoder, Frame, Message, encode};
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
        let json = document
            .get("json")
            .unwrap_or_else(|| panic!("{name} has a json field"));
        let frame = unhex(
            document
                .get("frame")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{name} has a frame field")),
        );

        let message: Message = serde_json::from_value(json.clone())
            .unwrap_or_else(|error| panic!("{name} does not parse: {error}"));

        assert_eq!(
            encode(&message).unwrap_or_else(|error| panic!("{name} does not encode: {error}")),
            frame,
            "{name} encodes to its recorded frame"
        );
        assert_eq!(
            serde_json::to_value(&message).expect("a message serializes"),
            *json,
            "{name} keeps its fields"
        );

        let mut decoder = Decoder::new();
        decoder.push(&frame);
        assert_eq!(
            decoder.poll().expect("no frame error"),
            Some(Frame::Message(message)),
            "{name} decodes from its recorded frame"
        );
        assert_eq!(
            decoder.poll().expect("no frame error"),
            None,
            "{name} is exactly one frame"
        );
    }
}
