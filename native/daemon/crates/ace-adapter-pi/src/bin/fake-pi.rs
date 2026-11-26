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
//! `FAKE_PI_LOAD_FAILURE`, `FAKE_PI_CRASH_MID_TURN`, `FAKE_PI_CANCEL_SWITCH`, `FAKE_PI_ARGS_FILE`,
//! `FAKE_PI_SLOW_STATE_MS` and `FAKE_PI_SLOW_STATE_MARKER` (a late handshake reply).

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use ace_json::{JsString, Map, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let extension = flag(&args, "-e").unwrap_or_default();
    if let Some(path) = std::env::var_os("FAKE_PI_ARGS_FILE") {
        let _ = std::fs::write(path, args.join("\u{1f}"));
    }
    let configuration = configuration();
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
                // `FAKE_PI_SLOW_STATE_MS`: a handshake Pi answers late, so a test can cancel an
                // open while it waits. The marker file proves the reply is the delayed one.
                if let Some(ms) = std::env::var("FAKE_PI_SLOW_STATE_MS")
                    .ok()
                    .and_then(|ms| ms.parse::<u64>().ok())
                {
                    if let Some(marker) = std::env::var_os("FAKE_PI_SLOW_STATE_MARKER") {
                        let _ = std::fs::write(marker, b"waiting");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                }
                let mut data = Map::with_capacity(5);
                data.insert(
                    "sessionFile",
                    Value::from(history.path.to_string_lossy().as_ref()),
                );
                // `FAKE_PI_WRONG_ID`: the header names one id and Pi reports another.
                let reported = if std::env::var_os("FAKE_PI_WRONG_ID").is_some() {
                    "wrong-native-id".to_owned()
                } else {
                    history.id.clone()
                };
                data.insert("sessionId", Value::from(reported.as_str()));
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
                if message.starts_with("/ace-rollback ") {
                    // As Pi's ace extension echoes the control secret, which ace must redact.
                    let mut request = Map::with_capacity(4);
                    request.insert("type", Value::from("extension_ui_request"));
                    request.insert("id", Value::from("control-echo"));
                    request.insert("method", Value::from("notify"));
                    request.insert(
                        "message",
                        Value::from(configuration.control_secret.as_str()),
                    );
                    emit(&mut stdout, request);
                    eprintln!("control={}", configuration.control_secret);
                    reply(&mut stdout, id, kind, Value::Object(Map::new()));
                    continue;
                }
                if message == "refuse" || message.starts_with("/refuse") {
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
                if message == "fatal" && std::env::var_os("FAKE_PI_MALFORMED_ON_PROMPT").is_some() {
                    // A stdout line the wire cannot read: the session's fatal path.
                    let _ = writeln!(std::io::stdout(), "not a json line");
                    let _ = std::io::stdout().flush();
                    continue;
                }
                if message == "spawn-child" {
                    spawn_descendant();
                }
                if message == "spawn-detached" {
                    spawn_descendant_detached();
                }
                if message == "dialogs" {
                    for (id, method, options, timeout) in [
                        ("select", "select", Some(vec!["Tabs", "Spaces"]), None),
                        ("confirm", "confirm", None, None),
                        ("editor", "editor", None, None),
                        ("timed", "input", None, Some(25.0)),
                    ] {
                        let mut dialog = Map::with_capacity(5);
                        dialog.insert("type", Value::from("extension_ui_request"));
                        dialog.insert("id", Value::from(id));
                        dialog.insert("method", Value::from(method));
                        dialog.insert("title", Value::from("Pi extension"));
                        if let Some(options) = options {
                            dialog.insert(
                                "options",
                                Value::Array(
                                    options
                                        .into_iter()
                                        .map(Value::from)
                                        .collect::<Vec<_>>()
                                        .into(),
                                ),
                            );
                        }
                        if let Some(timeout) = timeout {
                            dialog.insert("timeout", Value::from(timeout));
                        }
                        emit(&mut stdout, dialog);
                    }
                }
                let text = if message == "env-proof" {
                    configuration.bearer.clone().unwrap_or_default()
                } else {
                    "hello\u{2028}world\u{2029}!".to_owned()
                };
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
                delta.insert("delta", Value::from(text.as_str()));
                message_update.insert("assistantMessageEvent", Value::Object(delta));
                emit(&mut stdout, message_update);
                let mut message_map = Map::with_capacity(4);
                message_map.insert("role", Value::from("assistant"));
                let mut block = Map::with_capacity(2);
                block.insert("type", Value::from("text"));
                block.insert("text", Value::from(text.as_str()));
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
                if message == "spawn-child" && std::env::var_os("FAKE_PI_SPAWN_THEN_EXIT").is_some()
                {
                    // A natural exit: the descendant is still running when the leader goes.
                    let _ = std::io::stdout().flush();
                    std::process::exit(0);
                }
                if message == "spawn-detached"
                    && std::env::var_os("FAKE_PI_SPAWN_DETACHED_THEN_EXIT").is_some()
                {
                    let _ = std::io::stdout().flush();
                    std::process::exit(0);
                }
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
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == name)?;
    args.get(at + 1).cloned()
}

/// A descendant that ignores SIGTERM, as an agent-started dev server can.
fn spawn_descendant() {
    spawn_descendant_with(false);
}

/// A descendant with its own stdio, as a `setsid` dev server has: the leader's pipes close at
/// its exit while the descendant runs on.
fn spawn_descendant_detached() {
    spawn_descendant_with(true);
}

fn spawn_descendant_with(detached: bool) {
    let Ok(script) = std::env::var("FAKE_PI_DESCENDANT_SCRIPT") else {
        return;
    };
    let mut command = std::process::Command::new("sh");
    command.arg("-c").arg(script);
    if detached {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
    }
    let Ok(child) = command.spawn() else {
        return;
    };
    if let Ok(home) = std::env::var("FAKE_PI_HOME") {
        let _ = std::fs::write(
            std::path::Path::new(&home).join("descendant.pid"),
            child.id().to_string(),
        );
    }
    // The descendant outlives this process unless ace kills the group.
    std::mem::forget(child);
}

/// The private configuration, read as `readPrivateMcpConfig` reads it: no symlink, mode 0600,
/// this user's, at most 256 KiB, and the shape `fake-pi.ts` parses (`controlSecret` required,
/// `mcp.bearer` optional). The TypeScript fake throws at startup on a wrong shape; so does this.
struct FakeConfiguration {
    control_secret: String,
    bearer: Option<String>,
}

fn configuration() -> FakeConfiguration {
    let Ok(path) = std::env::var("ACE_PI_SESSION_FILE") else {
        eprintln!("Invalid private MCP configuration: no file");
        std::process::exit(2);
    };
    let Ok(text) = read_private(&path) else {
        eprintln!("Invalid private MCP configuration");
        std::process::exit(2);
    };
    let Ok(value) = ace_json::parse(&text) else {
        eprintln!("Invalid private MCP configuration: not JSON");
        std::process::exit(2);
    };
    let Some(control_secret) = value.get("controlSecret").and_then(Value::as_str) else {
        eprintln!("Invalid private MCP configuration: controlSecret");
        std::process::exit(2);
    };
    FakeConfiguration {
        control_secret: control_secret.to_owned(),
        bearer: value
            .get("mcp")
            .and_then(|mcp| mcp.get("bearer"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

#[cfg(unix)]
fn read_private(path: &str) -> std::io::Result<String> {
    use std::io::Read as _;
    use std::os::unix::fs::MetadataExt as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let info = file.metadata()?;
    if !info.is_file()
        || info.mode() & 0o777 != 0o600
        || info.size() > 256 * 1024
        || Some(info.uid()) != parent_uid(path)
    {
        return Err(std::io::Error::other("Invalid private MCP configuration"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

/// The file must belong to the same user as the directory that holds it, which the session
/// created: no dependency on the process's own uid, and a file planted by someone else fails.
#[cfg(unix)]
fn parent_uid(path: &str) -> Option<u32> {
    use std::os::unix::fs::MetadataExt as _;
    std::path::Path::new(path)
        .parent()
        .and_then(|parent| std::fs::metadata(parent).ok())
        .map(|meta| meta.uid())
}

#[cfg(not(unix))]
fn read_private(path: &str) -> std::io::Result<String> {
    std::fs::read_to_string(path)
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
