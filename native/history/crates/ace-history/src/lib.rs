// SPDX-License-Identifier: Apache-2.0

//! The reader process: history-wire on stdin and stdout.

use std::io::{Read, Write};

use history_wire::{Decoder, Frame, Inbound, encode_json};
use serde_json::json;

/// Serve the daemon until stdin closes. Returns the exit code.
pub fn run() -> i32 {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut decoder = Decoder::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match stdin.read(&mut chunk) {
            Ok(0) | Err(_) => return 0,
            Ok(read) => read,
        };
        decoder.push(&chunk[..read]);
        while let Ok(Some(frame)) = decoder.poll() {
            let Frame::Json(text) = frame else { continue };
            let reply = match Inbound::parse(&text) {
                Inbound::Init(_) => json!({ "id": 0, "value": "ready" }),
                Inbound::Envelope { id, .. } => json!({ "id": id, "error": "Not built yet" }),
                Inbound::Cancel | Inbound::Unknown => continue,
            };
            let Ok(bytes) = encode_json(&reply) else {
                return 1;
            };
            if stdout
                .write_all(&bytes)
                .and_then(|()| stdout.flush())
                .is_err()
            {
                return 0;
            }
        }
    }
}
