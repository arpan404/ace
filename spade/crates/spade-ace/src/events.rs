//! ace's thread events for Spade's routines (ADR 0129). The daemon's WebSocket serves the threads
//! subscription its own app uses; each entry carries the whole-tree status the daemon computes.
//! Spade keeps the last status it saw per thread and reports a change into `done`, `failed` or
//! `needs_you`. The first list it ever sees is the baseline, so nothing old fires; after a
//! reconnect, a thread that changed meanwhile fires once.
//!
//! Mirrors, by hand and with only the fields read: the `hello` and `subscribe` arms of
//! `CoreClientMessage` and the `snapshot` and `threads.patch` arms of the server messages in
//! `packages/protocol/src/wire-core.ts`, and `ThreadStatus` in `thread-status.ts`.

use std::collections::HashMap;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use crate::SkillsConfig;

/// Threads in the subscription's window: the daemon's most recently changed ones.
const WINDOW: u32 = 20;
const SUBSCRIPTION: &str = "spade-routines";

/// A status a routine can wait for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThreadState {
    Done,
    Failed,
    NeedsYou,
}

impl ThreadState {
    fn of(state: &str) -> Option<Self> {
        match state {
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "needs_you" => Some(Self::NeedsYou),
            _ => None,
        }
    }
}

/// A thread the person started changed into `state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadChange {
    pub thread_id: String,
    pub title: String,
    pub state: ThreadState,
}

/// The longest snapshot Spade reassembles from parts, in bytes of JSON.
const MOST_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

/// What Spade last saw of each thread. Kept across reconnects; pure.
#[derive(Debug, Default)]
pub struct ThreadWatch {
    known: HashMap<String, String>,
    baseline: bool,
    /// A snapshot arriving in parts on the current socket, with patches that came meanwhile.
    assembling: Option<Assembly>,
}

#[derive(Debug)]
struct Assembly {
    seq: u64,
    next: u64,
    data: String,
    held: Vec<Value>,
}

impl ThreadWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// A `snapshot` view's `threads` record, or a `threads.patch`'s. The first one ever only
    /// records what it holds.
    pub fn saw(&mut self, threads: &Value, removed: &[String]) -> Vec<ThreadChange> {
        let mut changes = Vec::new();
        for id in removed {
            self.known.remove(id);
        }
        let Some(threads) = threads.as_object() else {
            return changes;
        };
        for (id, entry) in threads {
            // Only threads the person started count. One an agent delegated or started, one an
            // outside client (Spade included) started, or one held for a daemon process could be
            // a routine's own work: its finishing would wake that routine again, in a loop.
            if [
                "delegatedBy",
                "delegatedFrom",
                "startedBy",
                "startedByClient",
                "host",
            ]
            .iter()
            .any(|field| entry.get(field).is_some_and(|v| !v.is_null()))
            {
                continue;
            }
            let Some(state) = entry
                .get("status")
                .and_then(|s| s.get("state"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let before = self.known.insert(id.clone(), state.to_owned());
            if !self.baseline {
                continue;
            }
            if let (Some(before), Some(now)) = (before, ThreadState::of(state))
                && before != state
            {
                changes.push(ThreadChange {
                    thread_id: id.clone(),
                    title: entry
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    state: now,
                });
            }
        }
        self.baseline = true;
        changes
    }

    /// A new socket: a snapshot half-received on the last one is dropped.
    pub fn connected(&mut self) {
        self.assembling = None;
    }

    /// One server message on the subscription: a `snapshot`, a `snapshot.part` (whose parts,
    /// joined in order, are the snapshot message's JSON) or a `threads.patch`. Patches that
    /// arrive while a snapshot is still in parts wait for it. An error means the stream can't be
    /// trusted and should be opened again.
    pub fn message(&mut self, message: &Value) -> Result<Vec<ThreadChange>, String> {
        if !is_ours(message) {
            return Ok(Vec::new());
        }
        match message.get("type").and_then(Value::as_str) {
            Some("snapshot") => {
                self.assembling = None;
                Ok(self.snapshot(message))
            }
            Some("snapshot.part") => self.part(message),
            Some("threads.patch") => match &mut self.assembling {
                Some(assembly) => {
                    assembly.held.push(message.clone());
                    Ok(Vec::new())
                }
                None => Ok(self.patch(message)),
            },
            _ => Ok(Vec::new()),
        }
    }

    fn snapshot(&mut self, message: &Value) -> Vec<ThreadChange> {
        let view = message.get("view").unwrap_or(&Value::Null);
        if view.get("kind").and_then(Value::as_str) != Some("threads") {
            return Vec::new();
        }
        self.saw(view.get("threads").unwrap_or(&Value::Null), &[])
    }

    fn patch(&mut self, message: &Value) -> Vec<ThreadChange> {
        let removed: Vec<String> = message
            .get("removed")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        self.saw(message.get("threads").unwrap_or(&Value::Null), &removed)
    }

    fn part(&mut self, message: &Value) -> Result<Vec<ThreadChange>, String> {
        let number = |field: &str| message.get(field).and_then(Value::as_u64);
        let (Some(seq), Some(index)) = (number("seq"), number("index")) else {
            return Err("a snapshot part without its place".to_owned());
        };
        let data = message.get("data").and_then(Value::as_str).unwrap_or("");
        let done = message
            .get("done")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if index == 0 {
            self.assembling = Some(Assembly {
                seq,
                next: 0,
                data: String::new(),
                held: Vec::new(),
            });
        }
        let Some(assembly) = &mut self.assembling else {
            return Err("a snapshot part arrived without its first part".to_owned());
        };
        if assembly.seq != seq || assembly.next != index {
            self.assembling = None;
            return Err("snapshot parts arrived out of order".to_owned());
        }
        if assembly.data.len() + data.len() > MOST_SNAPSHOT_BYTES {
            self.assembling = None;
            return Err("the thread list's snapshot is too large".to_owned());
        }
        assembly.data.push_str(data);
        assembly.next += 1;
        if !done {
            return Ok(Vec::new());
        }
        let Some(assembly) = self.assembling.take() else {
            return Ok(Vec::new());
        };
        let whole: Value = serde_json::from_str(&assembly.data)
            .map_err(|_| "a snapshot's parts didn't join into one".to_owned())?;
        let whole_seq = whole.get("seq").and_then(Value::as_u64);
        if whole.get("type").and_then(Value::as_str) != Some("snapshot")
            || !is_ours(&whole)
            || whole_seq != Some(seq)
        {
            return Err("a snapshot's parts joined into something else".to_owned());
        }
        let mut changes = self.snapshot(&whole);
        for patch in &assembly.held {
            changes.extend(self.patch(patch));
        }
        Ok(changes)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("ace refused Spade's local token")]
    Refused,
    #[error("ace's event stream ended: {0}")]
    Ended(String),
}

/// Connects to the daemon's WebSocket, subscribes to its thread list and reports each change to
/// `on_change` until the socket ends. `watch` carries what was seen across calls.
pub async fn watch_threads(
    config: &SkillsConfig,
    watch: &mut ThreadWatch,
    mut on_change: impl FnMut(ThreadChange),
) -> Result<(), WatchError> {
    let token = config.token();
    let ended = |error: &dyn std::fmt::Display| WatchError::Ended(token.scrub(error.to_string()));
    let (mut stream, _) = tokio::time::timeout(
        config.timeout(),
        tokio_tungstenite::connect_async(config.url().as_str()),
    )
    .await
    .map_err(|_| WatchError::Ended("ace did not answer in time".to_owned()))?
    .map_err(|error| ended(&error))?;
    let hello = json!({
        "type": "hello",
        "protocolVersion": 1,
        "deviceId": config.device_id(),
        "token": token.expose(),
    });
    stream
        .send(Message::text(hello.to_string()))
        .await
        .map_err(|error| ended(&error))?;
    watch.connected();
    let mut subscribed = false;
    while let Some(frame) = stream.next().await {
        let text = match frame.map_err(|error| ended(&error))? {
            Message::Text(text) => text,
            Message::Close(frame) => {
                let code = frame.map(|f| u16::from(f.code));
                return Err(match code {
                    Some(4001 | 4003) => WatchError::Refused,
                    _ => WatchError::Ended("ace closed the socket".to_owned()),
                });
            }
            _ => continue,
        };
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("welcome") if !subscribed => {
                subscribed = true;
                let subscribe = json!({
                    "type": "subscribe",
                    "subscriptionId": SUBSCRIPTION,
                    "scope": { "kind": "threads", "window": { "limit": WINDOW } },
                });
                stream
                    .send(Message::text(subscribe.to_string()))
                    .await
                    .map_err(|error| ended(&error))?;
            }
            Some("error") if !subscribed => {
                let code = message.get("code").and_then(Value::as_str).unwrap_or("");
                if code == "unauthorized" {
                    return Err(WatchError::Refused);
                }
                return Err(WatchError::Ended(token.scrub(code.to_owned())));
            }
            Some(_) if subscribed => {
                let changes = watch.message(&message).map_err(WatchError::Ended)?;
                changes.into_iter().for_each(&mut on_change);
            }
            _ => {}
        }
    }
    Err(WatchError::Ended("ace closed the socket".to_owned()))
}

fn is_ours(message: &Value) -> bool {
    message.get("subscriptionId").and_then(Value::as_str) == Some(SUBSCRIPTION)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(state: &str) -> Value {
        json!({ "title": "Fix login", "status": { "state": state } })
    }

    #[test]
    fn the_first_list_is_only_a_baseline_and_a_change_into_done_fires_once() {
        let mut watch = ThreadWatch::new();
        assert!(watch.saw(&json!({ "t1": entry("done") }), &[]).is_empty());
        assert!(
            watch
                .saw(&json!({ "t2": entry("working") }), &[])
                .is_empty()
        );
        let changes = watch.saw(&json!({ "t2": entry("done") }), &[]);
        assert_eq!(
            changes,
            [ThreadChange {
                thread_id: "t2".into(),
                title: "Fix login".into(),
                state: ThreadState::Done,
            }]
        );
        // Seen again unchanged: nothing.
        assert!(watch.saw(&json!({ "t2": entry("done") }), &[]).is_empty());
        // Working again, then needing the person.
        watch.saw(&json!({ "t2": entry("working") }), &[]);
        let changes = watch.saw(&json!({ "t2": entry("needs_you") }), &[]);
        assert_eq!(changes[0].state, ThreadState::NeedsYou);
    }

    #[test]
    fn delegated_threads_never_fire() {
        let mut watch = ThreadWatch::new();
        let child = |state: &str| {
            json!({ "c1": { "title": "child", "status": { "state": state },
                            "delegatedBy": { "threadId": "t0" } } })
        };
        watch.saw(&child("working"), &[]);
        assert!(watch.saw(&child("done"), &[]).is_empty());
    }

    #[test]
    fn threads_an_agent_or_a_client_started_never_fire() {
        for (field, value) in [
            ("startedBy", json!({ "threadId": "t0", "agentId": "a1" })),
            (
                "startedByClient",
                json!({ "kind": "mcp_client", "grantId": "g", "name": "Spade" }),
            ),
        ] {
            let mut watch = ThreadWatch::new();
            let thread = |state: &str| {
                let mut entry = entry(state);
                entry[field] = value.clone();
                json!({ "t1": entry })
            };
            watch.saw(&thread("working"), &[]);
            assert!(watch.saw(&thread("done"), &[]).is_empty(), "{field} fired");
        }
    }

    fn ours(mut message: Value) -> Value {
        message["subscriptionId"] = json!(SUBSCRIPTION);
        message
    }

    #[test]
    fn a_snapshot_in_parts_is_joined_before_the_patches_that_came_meanwhile() {
        let mut watch = ThreadWatch::new();
        let snapshot = ours(json!({ "type": "snapshot", "seq": 4,
            "view": { "kind": "threads", "seq": 4, "threads": { "t1": entry("working") } } }))
        .to_string();
        let (head, tail) = snapshot.split_at(snapshot.len() / 2);
        let part = |index: u64, data: &str, done: bool| {
            ours(json!({ "type": "snapshot.part", "seq": 4, "index": index,
                         "done": done, "data": data }))
        };
        let patch = ours(json!({ "type": "threads.patch", "seq": 5,
                                 "threads": { "t1": entry("done") }, "removed": [] }));
        assert_eq!(watch.message(&part(0, head, false)), Ok(Vec::new()));
        // The patch waits for the snapshot it follows.
        assert_eq!(watch.message(&patch), Ok(Vec::new()));
        let changes = watch.message(&part(1, tail, true)).unwrap_or_default();
        assert_eq!(
            changes
                .iter()
                .map(|c| (c.thread_id.as_str(), c.state))
                .collect::<Vec<_>>(),
            [("t1", ThreadState::Done)]
        );
    }

    #[test]
    fn snapshot_parts_out_of_order_end_the_stream() {
        let mut watch = ThreadWatch::new();
        let part = |index: u64| {
            ours(json!({ "type": "snapshot.part", "seq": 1, "index": index,
                         "done": false, "data": "{" }))
        };
        assert!(watch.message(&part(0)).is_ok());
        assert!(watch.message(&part(2)).is_err());
    }

    #[test]
    fn a_thread_first_seen_already_done_does_not_fire() {
        let mut watch = ThreadWatch::new();
        watch.saw(&json!({}), &[]);
        assert!(watch.saw(&json!({ "t9": entry("done") }), &[]).is_empty());
    }
}
