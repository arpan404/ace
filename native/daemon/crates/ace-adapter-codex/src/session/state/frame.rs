// SPDX-License-Identifier: Apache-2.0
//! `handlers.frame` (`session.ts:185`-`:353`), statement for statement: the
//! control requests, the reply's controls and the revision they bump, the
//! recorded frame, then the live state the frame changes. The statement order is
//! the contract; the comments cite the TypeScript's lines.

use ace_json::{Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::Direction;

use super::Session;
use super::{
    ControlRequest, correlation_key, remember_historical_questions, rpc_of, text_of, turn_of,
};
use crate::session::frames::Effect;
use crate::session::frames::FrameDir;
use crate::translate::retention::RecentSet;

impl Session {
    /// One frame from the channel, and every effect it decided. `optional` is
    /// `optionalFrames.method(dir, data)`, the extension catalog's decision
    /// (E3-codex.4), which only says what a frame over the bound was.
    pub fn frame(
        &mut self,
        dir: Direction,
        data: &Value,
        optional: Option<&str>,
        now: f64,
    ) -> Vec<Effect> {
        let mut effects = Vec::new();
        let message = data.as_object().cloned().unwrap_or_default();
        let params = message
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let method = text_of(message.get("method"));
        let thread = text_of(params.get("threadId"));
        let submitted_mode = self.permission_mode.clone();
        // A control request records what it asked for before its answer arrives.
        if dir == Direction::Send
            && matches!(
                method.as_str(),
                "thread/start" | "thread/resume" | "thread/fork" | "turn/start"
            )
        {
            self.control_requests.insert(
                rpc_of(message.get("id")),
                ControlRequest {
                    method: method.clone(),
                    thread: thread.clone(),
                    mode: submitted_mode,
                    completed: RecentSet::new(),
                    excludes_turns: params.get("excludeTurns").and_then(Value::as_bool)
                        == Some(true),
                },
            );
        }
        let id = rpc_of(message.get("id"));
        if dir == Direction::Recv {
            // `:208`-`:250`: what this received frame proves.
            self.observe_recovery(&thread, &method, &turn_of(&params));
            if method == "turn/completed" {
                let turn = turn_of(&params);
                self.ended_turns.add(turn.clone());
                let ids: Vec<RpcId> = self
                    .control_requests
                    .iter()
                    .filter(|(_, entry)| entry.method == "turn/start" && entry.thread == thread)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Some(entry) = self.control_requests.get_mut(&id) {
                        entry.completed.add(turn.clone());
                    }
                    effects.extend(self.await_correlation(&id, &thread, now));
                }
            }
            let control = if method.is_empty() {
                self.control_requests.shift_remove(&id)
            } else {
                None
            };
            if method.is_empty()
                && let Some(key) = correlation_key(&id)
                && self.correlations.shift_remove(&key).is_some()
            {
                effects.push(Effect::CancelTimer { key });
            }
            let result = message
                .get("result")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let snapshot = result
                .get("thread")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(control) = control
                && !message.contains_key("error")
            {
                if control.method == "turn/start" {
                    let turn = text_of(
                        result
                            .get("turn")
                            .and_then(Value::as_object)
                            .and_then(|turn| turn.get("id")),
                    );
                    if !turn.is_empty() && !control.completed.has(&turn) {
                        self.active.insert(control.thread.clone(), turn.clone());
                    }
                    if !turn.is_empty() && control.thread == self.root {
                        self.applied_permission_mode = control.mode.clone();
                        let mut note = Map::new();
                        note.insert("event", Value::from("permission-mode-applied"));
                        note.insert(
                            "mode",
                            control.mode.clone().map(Value::from).unwrap_or(Value::Null),
                        );
                        effects.extend(self.emit_note(&Value::Object(note)));
                    }
                } else {
                    self.root = text_of(snapshot.get("id"));
                    if !self.root.is_empty() {
                        self.known.insert(self.root.clone());
                        if !control.excludes_turns {
                            if snapshot.get("turns").is_some_and(Value::is_array) {
                                self.recovered.insert(self.root.clone());
                            }
                            remember_historical_questions(
                                &Value::Object(snapshot.clone()),
                                &mut self.seen_questions,
                            );
                            self.hydrate(&Value::Object(snapshot.clone()));
                        }
                    }
                }
            }
            if !thread.is_empty()
                && (self.known.contains(&thread) || self.reading.contains(&thread))
                && matches!(
                    method.as_str(),
                    "turn/started" | "turn/completed" | "item/started" | "item/completed"
                )
            {
                let revision = self.revisions.get(&thread).copied().unwrap_or(0) + 1;
                self.revisions.insert(thread.clone(), revision);
            }
        }
        if dir == Direction::Recv && method == "turn/completed" && thread == self.root {
            let mut note = Map::new();
            note.insert("event", Value::from("discovery-start"));
            note.insert("threadId", Value::from(thread.clone()));
            note.insert(
                "task",
                Value::from(format!("discovery:{}", turn_of(&params))),
            );
            effects.extend(self.emit_note(&Value::Object(note)));
        }
        if dir == Direction::Send && method == "thread/read" {
            self.scoped_reads.insert(id.clone());
        }
        if dir == Direction::Send && method == "thread/turns/list" {
            self.history_replies.insert(id.clone());
        }
        let scoped = dir == Direction::Recv && self.scoped_reads.shift_remove(&id);
        let history = dir == Direction::Recv && (self.history_replies.shift_remove(&id) || scoped);
        // History replies grow with the thread; their turns are recorded as
        // bounded notes.
        let recorded = if history {
            crate::session::frames::compact_history_reply(data)
        } else {
            data.clone()
        };
        let channel = if scoped {
            "codex-discovery"
        } else if history {
            "codex-history"
        } else {
            "stdio"
        };
        match self.emit(dir, &recorded, channel, optional) {
            Ok(ref mut emitted) => effects.append(emitted),
            Err(rejected) => {
                // A received frame the bound refuses retires the transport, as
                // the TypeScript's throw out of the callback closes the peer. An
                // outgoing frame is the writer's: it is left out, and the
                // session goes on (`session.ts:153`-`:156`).
                if rejected.fail_transport {
                    let busy = self.busy();
                    effects.extend(self.lifetime.fail_transport(&self.frames, busy));
                }
                return effects;
            }
        }
        if dir != Direction::Recv {
            return effects;
        }
        // `:253`-`:300`: the live state the received frame changes. At most 256
        // recovery timers come from this path (`:277`).
        if !thread.is_empty()
            && !self.known.contains(&thread)
            && !self.timers.contains_key(&thread)
            && self.timers.len() < super::TIMER_LIMIT
        {
            effects.extend(self.schedule_recovery(&thread));
        }
        if method == "turn/started" {
            let turn = turn_of(&params);
            self.active.insert(thread.clone(), turn);
        }
        if method == "turn/completed" {
            let turn = turn_of(&params);
            if self.active.get(&thread) == Some(&turn) {
                self.active.shift_remove(&thread);
            }
            let ended: Vec<(String, RpcId)> = self
                .pending
                .iter()
                .filter(|(_, entry)| {
                    let params = entry
                        .params
                        .as_ref()
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    text_of(params.get("threadId")) == thread
                        && text_of(params.get("turnId")) == turn
                })
                .map(|(key, entry)| (key.clone(), entry.id.clone()))
                .collect();
            for (key, id) in ended {
                self.pending.shift_remove(&key);
                effects.push(Effect::AnswerError {
                    id,
                    message: "Turn ended before interaction was answered".to_owned(),
                });
            }
        }
        if method == "serverRequest/resolved" {
            let key = crate::translate::helpers::request_key(
                params.get("requestId").unwrap_or(&Value::Null),
                &self.scope,
            );
            if let Some(entry) = self.pending.shift_remove(key.as_str()) {
                effects.push(Effect::AnswerError {
                    id: entry.id,
                    message: "Interaction resolved on another connection".to_owned(),
                });
            }
        }
        if method == "item/commandExecution/outputDelta"
            && !self
                .completed_shells
                .contains(&text_of(params.get("itemId")))
        {
            self.shells
                .insert(text_of(params.get("itemId")), thread.clone());
        }
        if method == "item/started" || method == "item/completed" {
            let item = params
                .get("item")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let item_value = Value::Object(item.clone());
            let item_id = text_of(item.get("id"));
            if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall")
                && item.get("tool").and_then(Value::as_str) == Some("spawnAgent")
            {
                let receivers = item
                    .get("receiverThreadIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for receiver in receivers {
                    let child = text_of(Some(&receiver));
                    if !child.is_empty() {
                        effects.extend(self.discover_child(&child, &thread));
                    }
                }
            }
            if item.get("type").and_then(Value::as_str) == Some("subAgentActivity")
                && item.get("kind").and_then(Value::as_str) == Some("started")
            {
                let child = text_of(item.get("agentThreadId"));
                if !child.is_empty() {
                    effects.extend(self.discover_child(&child, &thread));
                }
            }
            if item.get("type").and_then(Value::as_str) == Some("commandExecution") {
                if method == "item/started" {
                    self.shells.insert(item_id.clone(), thread.clone());
                } else {
                    self.shells.shift_remove(&item_id);
                    self.completed_shells.insert(item_id.clone());
                }
            }
            if !item_id.is_empty()
                && crate::translate::helpers::is_async_question(&item_value)
                && !self.seen_questions.contains(&item_id)
            {
                self.seen_questions.insert(item_id.clone());
                self.async_questions.insert(
                    crate::translate::helpers::async_key(&item_id),
                    super::AsyncQuestion {
                        thread: thread.clone(),
                        questions: item.get("questions").cloned().unwrap_or(Value::Null),
                    },
                );
            }
            let turn_id = text_of(params.get("turnId"));
            if item.get("type").and_then(Value::as_str) == Some("plan")
                && method == "item/completed"
                && self.active.get(&thread) == Some(&turn_id)
            {
                self.plans.insert(
                    crate::translate::helpers::plan_key(&turn_id),
                    super::Plan {
                        thread: thread.clone(),
                        markdown: text_of(item.get("text")),
                    },
                );
            }
        }
        effects
    }

    /// `hydrateControls(snapshot, active, shells, endedTurns)`.
    fn hydrate(&mut self, thread: &Value) {
        super::hydrate_controls(
            thread,
            &mut self.active,
            &mut self.shells,
            &self.ended_turns,
        );
    }
}

/// `FrameDir` is re-exported for the frame's own direction mapping.
const _: FrameDir = FrameDir::Recv;
