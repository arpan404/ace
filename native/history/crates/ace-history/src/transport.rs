// SPDX-License-Identifier: Apache-2.0

//! Frames out on stdout, from any thread, one whole message at a time.

use std::io::Write;
use std::sync::{Arc, Mutex};

use history_wire::{encode_body, encode_json};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Out(Arc<Mutex<std::io::Stdout>>);

impl Out {
    pub fn new() -> Out {
        Out(Arc::new(Mutex::new(std::io::stdout())))
    }

    /// Send `message`, preceded by its bodies tagged with `id`. A closed pipe ends the reader.
    pub fn send(&self, message: &Value, bodies: &[Vec<u8>], id: i64) {
        let mut frames = Vec::new();
        for body in bodies {
            match encode_body(u64::try_from(id).unwrap_or(0), body) {
                Ok(frame) => frames.push(frame),
                Err(_) => {
                    return self.send(
                        &json!({ "id": id, "error": "History reply is too large" }),
                        &[],
                        id,
                    );
                }
            }
        }
        match encode_json(message) {
            Ok(frame) => frames.push(frame),
            Err(_) => {
                return self.send(
                    &json!({ "id": id, "error": "History reply is too large" }),
                    &[],
                    id,
                );
            }
        }
        let Ok(mut out) = self.0.lock() else {
            std::process::exit(1)
        };
        for frame in frames {
            if out.write_all(&frame).is_err() {
                std::process::exit(0);
            }
        }
        if out.flush().is_err() {
            std::process::exit(0);
        }
    }

    pub fn reply(&self, id: i64, value: Value) {
        self.send(&json!({ "id": id, "value": value }), &[], id);
    }

    pub fn reply_bodies(&self, id: i64, value: Value, bodies: &[Vec<u8>]) {
        self.send(&json!({ "id": id, "value": value }), bodies, id);
    }

    pub fn error(&self, id: i64, message: &str) {
        self.send(&json!({ "id": id, "error": message }), &[], id);
    }
}

impl Default for Out {
    fn default() -> Out {
        Out::new()
    }
}
