// SPDX-License-Identifier: Apache-2.0
//! Ace's synthetic Pi CLI for Rust tests: the documented RPC peer, never a real Pi.
//!
//! A Rust port of `packages/adapter-pi/src/testing/fake-pi.ts`, kept to what the session's
//! process tests drive: the open handshake (`get_commands`, `get_state`), a turn, steering,
//! the interrupt's three commands, a session switch, a prompt Pi refuses, a crash mid-turn and
//! a load failure that exits before any RPC. It reads the private configuration file the
//! session writes, exactly as the extension would.
//!
//! Environment hooks: `FAKE_PI_HOME` (the history home), `FAKE_PI_EXTENSION_MISSING`,
//! `FAKE_PI_LOAD_FAILURE`, `FAKE_PI_CRASH_MID_TURN`, `FAKE_PI_CANCEL_SWITCH`, `FAKE_PI_ARGS_FILE`.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use ace_json::{JsString, Map, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let extension = flag(&args, "-e").unwrap_or_default();
    if let Some(path) = std::env::var_os("FAKE_PI_ARGS_FILE") {
        let _ = std::fs::write(path, args.join("\u{1f}"));
    }
    let secret = control_secret();
    let config_path = std::env::var("ACE_PI_SESSION_FILE").unwrap_or_default();
    if std::env::var_os("FAKE_PI_LOAD_FAILURE").is_some() {
        // As Pi does when an extension factory throws: say why on stderr, then exit before RPC.
        eprint!(
            "Error: Failed to load extension \"{extension}\": Failed to load extension: synthetic factory failure\n\
             Hint: Start without extensions using \"pi -ne\".\n"
        );
        std::process::exit(1);
    }
    let mut history = History::load();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut queue = false;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(command) = ace_json::parse(&line) else {
            continue;
        };
        let kind = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id = command
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "get_commands" => {
                let commands = if std::env::var_os("FAKE_PI_EXTENSION_MISSING").is_some() {
                    Value::Array(Vec::new().into())
                } else {
                    Value::Array(
                        vec![Value::Object({
                            let mut map = Map::with_capacity(3);
                            map.insert("name", Value::from("ace-rollback"));
                            map.insert("source", Value::from("extension"));
                            let mut info = Map::with_capacity(1);
                            info.insert("path", Value::from(extension.as_str()));
                            map.insert("sourceInfo", Value::Object(info));
                            map
                        })]
                        .into(),
                    )
                };
                let mut data = Map::with_capacity(1);
                data.insert("commands", commands);
                reply(&mut stdout, id, kind, Value::Object(data));
            }
            "get_state" => {
                let mut data = Map::with_capacity(5);
                data.insert(
                    "sessionFile",
                    Value::from(history.path.to_string_lossy().as_ref()),
                );
                data.insert("sessionId", Value::from(history.id.as_str()));
                data.insert("isStreaming", Value::Bool(false));
                data.insert("isCompacting", Value::Bool(false));
                data.insert(
                    "pendingMessageCount",
                    Value::from(if queue { 1.0 } else { 0.0 }),
                );
                reply(&mut stdout, id, kind, Value::Object(data));
            }
            "switch_session" => {
                if std::env::var_os("FAKE_PI_CANCEL_SWITCH").is_some() {
                    let mut data = Map::with_capacity(1);
                    data.insert("cancelled", Value::Bool(true));
                    reply(&mut stdout, id, kind, Value::Object(data));
                    continue;
                }
                if let Some(path) = command.get("sessionPath").and_then(Value::as_str) {
                    history = History::at(Path::new(path));
                }
                let mut data = Map::with_capacity(1);
                data.insert("cancelled", Value::Bool(false));
                reply(&mut stdout, id, kind, Value::Object(data));
            }
            "clear_queue" => {
                queue = false;
                reply(&mut stdout, id, kind, Value::Object(Map::new()));
            }
            "abort" => {
                notify(
                    &mut stdout,
                    "abort-proof",
                    if queue {
                        "queue still live"
                    } else {
                        "queue cleared"
                    },
                );
                emit(&mut stdout, agent_event("agent_settled"));
                reply(&mut stdout, id, kind, Value::Object(Map::new()));
            }
            "abort_bash" => reply(&mut stdout, id, kind, Value::Object(Map::new())),
            "extension_ui_response" => {
                notify(&mut stdout, "answer-proof", &line);
            }
            "prompt" => {
                let message = command
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if message == "refuse" {
                    // Pi turns down a prompt it never accepted with one failed response.
                    emit(
                        &mut stdout,
                        response(id, kind, false, Value::Null, Some("No model")),
                    );
                    continue;
                }
                if message.starts_with("/ace-context ") {
                    reply(&mut stdout, id, kind, Value::Object(Map::new()));
                    continue;
                }
                emit(&mut stdout, agent_event("agent_start"));
                notify(&mut stdout, "input-proof", &line);
                if std::env::var_os("FAKE_PI_CRASH_MID_TURN").is_some() {
                    let _ = writeln!(std::io::stderr(), "synthetic crash mid-turn");
                    let _ = std::io::stderr().flush();
                    std::process::exit(3);
                }
                if message == "queued" {
                    queue = true;
                }
                let text = "hello\u{2028}world\u{2029}!";
                let mut message_start = agent_event("message_start");
                let mut started = Map::with_capacity(2);
                started.insert("role", Value::from("assistant"));
                started.insert("content", Value::Array(Vec::new().into()));
                message_start.insert("message", Value::Object(started));
                emit(&mut stdout, message_start);
                let mut message_update = agent_event("message_update");
                let mut delta = Map::with_capacity(4);
                delta.insert("type", Value::from("text_delta"));
                delta.insert("contentIndex", Value::from(0.0));
                delta.insert("delta", Value::from(text));
                message_update.insert("assistantMessageEvent", Value::Object(delta));
                emit(&mut stdout, message_update);
                let mut message_map = Map::with_capacity(4);
                message_map.insert("role", Value::from("assistant"));
                let mut block = Map::with_capacity(2);
                block.insert("type", Value::from("text"));
                block.insert("text", Value::from(text));
                message_map.insert("content", Value::Array(vec![Value::Object(block)].into()));
                message_map.insert("stopReason", Value::from("stop"));
                let mut usage = Map::with_capacity(2);
                usage.insert("input", Value::from(5.0));
                usage.insert("output", Value::from(3.0));
                message_map.insert("usage", Value::Object(usage));
                let mut message_end = agent_event("message_end");
                message_end.insert("message", Value::Object(message_map));
                emit(&mut stdout, message_end);
                let mut end = agent_event("agent_end");
                end.insert("messages", Value::Array(Vec::new().into()));
                end.insert("willRetry", Value::Bool(false));
                emit(&mut stdout, end);
                emit(&mut stdout, agent_event("agent_settled"));
                reply(&mut stdout, id, kind, Value::Object(Map::new()));
            }
            _ => emit(
                &mut stdout,
                response(
                    id,
                    kind,
                    false,
                    Value::Null,
                    Some("Unknown synthetic command"),
                ),
            ),
        }
        let _ = stdout.flush();
        let _ = &secret;
        let _ = &config_path;
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == name)?;
    args.get(at + 1).cloned()
}

/// The private configuration's control secret, written by the session under test.
fn control_secret() -> String {
    let Ok(path) = std::env::var("ACE_PI_SESSION_FILE") else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    ace_json::parse(&text)
        .ok()
        .and_then(|value| {
            value
                .get("controlSecret")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

struct History {
    path: PathBuf,
    id: String,
}

impl History {
    /// `NativeHistory.load`: the home's `source.jsonl` header, else a fresh empty session.
    fn load() -> History {
        let home = std::env::var("FAKE_PI_HOME").unwrap_or_else(|_| "/synthetic".to_owned());
        History::at(&Path::new(&home).join("source.jsonl"))
    }

    fn at(path: &Path) -> History {
        let id = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| {
                let first = text.lines().next()?.to_owned();
                let value = ace_json::parse(&first).ok()?;
                if value.get("type").and_then(Value::as_str) != Some("session") {
                    return None;
                }
                value.get("id").and_then(Value::as_str).map(str::to_owned)
            })
            .unwrap_or_else(|| "fresh-empty".to_owned());
        History {
            path: path.to_path_buf(),
            id,
        }
    }
}

fn agent_event(kind: &str) -> Map {
    let mut map = Map::with_capacity(1);
    map.insert("type", Value::String(JsString::from(kind)));
    map
}

fn emit(out: &mut std::io::Stdout, data: Map) {
    let _ = writeln!(out, "{}", ace_json::to_string(&Value::Object(data)));
}

fn notify(out: &mut std::io::Stdout, id: &str, message: &str) {
    let mut map = Map::with_capacity(4);
    map.insert("type", Value::from("extension_ui_request"));
    map.insert("id", Value::from(id));
    map.insert("method", Value::from("notify"));
    map.insert("message", Value::from(message));
    emit(out, map);
}

fn response(id: &str, command: &str, success: bool, data: Value, error: Option<&str>) -> Map {
    let mut map = Map::with_capacity(6);
    map.insert("type", Value::from("response"));
    map.insert("id", Value::from(id));
    map.insert("command", Value::from(command));
    map.insert("success", Value::Bool(success));
    map.insert("data", data);
    if let Some(error) = error {
        map.insert("error", Value::from(error));
    }
    map
}

fn reply(out: &mut std::io::Stdout, id: &str, command: &str, data: Value) {
    emit(out, response(id, command, true, data, None));
}
