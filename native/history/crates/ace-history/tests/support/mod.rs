// SPDX-License-Identifier: Apache-2.0

//! ace-history driven as the daemon drives it: framed messages on its stdin and stdout.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic, dead_code)]

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use history_wire::{Decoder, Frame, encode_json};
use serde_json::{Value, json};

pub struct Reader {
    pub child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    decoder: Decoder,
}

/// A message and the bodies sent before it.
pub struct Message {
    pub value: Value,
    pub bodies: Vec<Vec<u8>>,
}

impl Reader {
    pub fn start(options: Value) -> Reader {
        Reader::start_with(options, &Value::Null)
    }

    /// Started with test hooks (`ACE_HISTORY_TEST_HOOKS`).
    pub fn start_with(options: Value, hooks: &Value) -> Reader {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ace-history"))
            .env("ACE_HISTORY_TEST_HOOKS", hooks.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = Reader {
            child,
            stdin,
            stdout,
            decoder: Decoder::new(),
        };
        reader.send(&json!({ "init": options }));
        reader
    }

    pub fn send(&mut self, value: &Value) {
        self.stdin.write_all(&encode_json(value).unwrap()).unwrap();
        self.stdin.flush().unwrap();
    }

    pub fn next(&mut self) -> Message {
        let mut bodies = Vec::new();
        loop {
            while let Some(frame) = self.decoder.poll().expect("frame") {
                match frame {
                    Frame::Body { bytes, .. } => bodies.push(bytes),
                    Frame::Json(text) => {
                        return Message {
                            value: serde_json::from_slice(&text).unwrap(),
                            bodies,
                        };
                    }
                }
            }
            let mut chunk = [0u8; 65536];
            let read = self.stdout.read(&mut chunk).unwrap();
            assert!(read > 0, "ace-history closed its stdout");
            self.decoder.push(&chunk[..read]);
        }
    }

    /// The reply to request `id`, skipping progress.
    pub fn call(&mut self, id: i64, request: Value) -> Message {
        self.send(&json!({ "id": id, "request": request }));
        loop {
            let message = self.next();
            if message.value.get("id") == Some(&json!(id)) {
                return message;
            }
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn line(value: Value) -> String {
    format!("{value}\n")
}

pub fn claude_home(root: &Path, transcript: &str) -> Value {
    let project = root.join("claude/projects/p");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("11111111-1111-4111-8111-111111111111.jsonl"),
        transcript,
    )
    .unwrap();
    json!({ "id": "home", "provider": "claude", "homeDir": root.join("claude") })
}

pub fn options(root: &Path, homes: Vec<Value>) -> Value {
    json!({ "indexPath": root.join("ace/index.sqlite"), "instances": homes, "snapshot": { "minFreeBytes": 0, "minFreeRatio": 0 } })
}

pub fn session(prompt: &str) -> String {
    line(
        json!({ "type": "user", "sessionId": "11111111-1111-4111-8111-111111111111", "cwd": "/w", "message": { "role": "user", "content": prompt } }),
    )
}
