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

/// What Spade last saw of each thread. Kept across reconnects; pure.
#[derive(Debug, Default)]
pub struct ThreadWatch {
    known: HashMap<String, String>,
    baseline: bool,
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
            // A thread an agent delegated, or one held for a daemon process, is not the person's
            // own: its finishing would wake the bot that delegated it in a loop.
            if ["delegatedBy", "delegatedFrom", "host"]
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
            Some("snapshot") if is_ours(&message) => {
                let view = message.get("view").unwrap_or(&Value::Null);
                if view.get("kind").and_then(Value::as_str) == Some("threads") {
                    let threads = view.get("threads").unwrap_or(&Value::Null);
                    watch.saw(threads, &[]).into_iter().for_each(&mut on_change);
                }
            }
            Some("threads.patch") if is_ours(&message) => {
                let removed: Vec<String> = message
                    .get("removed")
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(|id| id.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let threads = message.get("threads").unwrap_or(&Value::Null);
                watch
                    .saw(threads, &removed)
                    .into_iter()
                    .for_each(&mut on_change);
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
        assert!(watch.saw(&json!({ "t2": entry("working") }), &[]).is_empty());
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
    fn a_thread_first_seen_already_done_does_not_fire() {
        let mut watch = ThreadWatch::new();
        watch.saw(&json!({}), &[]);
        assert!(watch.saw(&json!({ "t9": entry("done") }), &[]).is_empty());
    }
}
