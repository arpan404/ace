// SPDX-License-Identifier: Apache-2.0

//! ace-history driven as the daemon drives it: framed messages on its stdin and stdout.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use history_wire::{Decoder, Frame, encode_json};
use serde_json::{Value, json};

struct Reader {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    decoder: Decoder,
}

/// A message and the bodies sent before it.
struct Message {
    value: Value,
    bodies: Vec<Vec<u8>>,
}

impl Reader {
    fn start(options: Value) -> Reader {
        Reader::start_with(options, &Value::Null)
    }

    /// Started with test hooks (`ACE_HISTORY_TEST_HOOKS`).
    fn start_with(options: Value, hooks: &Value) -> Reader {
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

    fn send(&mut self, value: &Value) {
        self.stdin.write_all(&encode_json(value).unwrap()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn next(&mut self) -> Message {
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
    fn call(&mut self, id: i64, request: Value) -> Message {
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

fn line(value: Value) -> String {
    format!("{value}\n")
}

fn claude_home(root: &Path, transcript: &str) -> Value {
    let project = root.join("claude/projects/p");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("11111111-1111-4111-8111-111111111111.jsonl"),
        transcript,
    )
    .unwrap();
    json!({ "id": "home", "provider": "claude", "homeDir": root.join("claude") })
}

fn options(root: &Path, homes: Vec<Value>) -> Value {
    json!({ "indexPath": root.join("ace/index.sqlite"), "instances": homes, "snapshot": { "minFreeBytes": 0, "minFreeRatio": 0 } })
}

fn session(prompt: &str) -> String {
    line(
        json!({ "type": "user", "sessionId": "11111111-1111-4111-8111-111111111111", "cwd": "/w", "message": { "role": "user", "content": prompt } }),
    )
}

#[test]
fn a_scanned_claude_session_is_listed_under_its_first_prompt() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(
        root.path(),
        &session("<system-reminder>hidden</system-reminder>Fix the retries"),
    );
    let mut reader = Reader::start(options(root.path(), vec![home]));
    assert_eq!(reader.next().value, json!({ "id": 0, "value": "ready" }));
    let scan = reader.call(1, json!({ "op": "scan" }));
    assert_eq!(scan.value["value"]["files"], 1);
    assert_eq!(scan.value["value"]["reads"], 1);
    let list = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w", "limit": 50 } }),
    );
    let sessions = list.value["value"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["title"], "Fix the retries");
    // Unchanged, the next scan reads nothing.
    let warm = reader.call(3, json!({ "op": "scan" }));
    assert_eq!(
        (
            warm.value["value"]["reads"].clone(),
            warm.value["value"]["skipped"].clone()
        ),
        (json!(0), json!(1))
    );
}

#[test]
fn an_index_of_another_format_is_refused_and_left_as_it_was() {
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("ace/index.sqlite");
    {
        let mut reader = Reader::start(options(root.path(), vec![]));
        assert_eq!(reader.next().value["value"], "ready");
    }
    rusqlite::Connection::open(&index)
        .unwrap()
        .execute(
            "UPDATE catalog_settings SET value='4' WHERE key='format'",
            [],
        )
        .unwrap();
    let mut reader = Reader::start(options(root.path(), vec![]));
    let refused = reader.next().value;
    assert_eq!(refused["refused"]["code"], "incompatible-data");
    assert!(
        refused["refused"]["message"]
            .as_str()
            .unwrap()
            .contains("format 4")
    );
    let db = rusqlite::Connection::open(&index).unwrap();
    let format: String = db
        .query_row(
            "SELECT value FROM catalog_settings WHERE key='format'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(format, "4");
}

#[test]
fn a_record_over_the_decode_limit_imports_as_bounded_blob_chunks() {
    let root = tempfile::tempdir().unwrap();
    let big = line(
        json!({ "type": "assistant", "message": { "role": "assistant", "content": "x".repeat(3 * 1024 * 1024) } }),
    );
    let home = claude_home(root.path(), &format!("{}{big}", session("question")));
    let mut reader = Reader::start(options(root.path(), vec![home]));
    reader.next();
    reader.call(1, json!({ "op": "scan" }));
    let list = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w", "limit": 50 } }),
    );
    let source = list.value["value"]["sessions"][0]["id"].clone();
    let init =
        json!({ "sourceId": source, "threadId": "t", "workspaceId": "w", "agentId": "a", "at": 1 });
    let mut message = reader.call(3, json!({ "op": "import", "init": init }));
    let (mut chunks, mut bytes, mut opaque) = (0, 0, 0);
    let mut id = 4;
    loop {
        let reply = &message.value["value"];
        for packet in reply["values"].as_array().unwrap() {
            if packet["type"] == "blob.chunk" {
                let body = &message.bodies[packet["bytes"]["$body"].as_u64().unwrap() as usize];
                assert!(body.len() <= 64 * 1024);
                chunks += 1;
                bytes += body.len();
            }
            if packet["type"] == "item" && packet["item"]["code"] == "history.raw-only" {
                opaque += 1;
            }
        }
        if reply["done"] == true {
            break;
        }
        message = reader.call(id, json!({ "op": "next" }));
        id += 1;
    }
    assert_eq!(bytes, big.len() - 1);
    assert!(chunks >= 48);
    assert_eq!(opaque, 1);
}

#[test]
fn a_second_operation_while_one_runs_is_refused_not_queued() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("q"));
    let mut reader = Reader::start(options(root.path(), vec![home]));
    reader.next();
    reader.send(&json!({ "id": 1, "request": { "op": "scan" } }));
    reader.send(&json!({ "id": 2, "request": { "op": "scan" } }));
    let mut answers = Vec::new();
    while answers.len() < 2 {
        let message = reader.next().value;
        if message.get("id").is_some() {
            answers.push(message);
        }
    }
    let refused = answers.iter().find(|a| a["id"] == 2).unwrap();
    assert_eq!(refused["error"], "History operation already in progress");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_request_sent_the_moment_the_last_reply_arrives_is_never_refused_as_in_progress() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("q"));
    // The reader lingers after each reply, as a loaded machine can make it.
    let hooks = json!({ "delay": { "at": "reply-sent", "ms": 30 } });
    let mut reader = Reader::start_with(options(root.path(), vec![home]), &hooks);
    reader.next();
    for id in 1..=10 {
        let reply = reader.call(id, json!({ "op": "archive.thread", "id": "missing" }));
        assert!(
            reply.value.get("error").is_none(),
            "request {id} was refused: {}",
            reply.value
        );
    }
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_reader_that_dies_while_creating_a_fresh_index_leaves_one_the_next_start_opens() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("q"));
    let opts = options(root.path(), vec![home]);
    let hooks = json!({ "crash": { "at": "index-schema" } });
    let mut dying = Reader::start_with(opts.clone(), &hooks);
    let status = dying.child.wait().unwrap();
    assert!(!status.success());
    drop(dying);
    let mut reader = Reader::start(opts);
    let ready = reader.next().value;
    assert_eq!(ready, json!({ "id": 0, "value": "ready" }));
}
