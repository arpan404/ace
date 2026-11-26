// SPDX-License-Identifier: Apache-2.0
//! Frame channels (`translator.ts`: frame). Clock, interaction, transport,
//! lifecycle, input, and HTTP frames fold here; SSE goes to the events.

use crate::translate::boundaries::{NativeEvent, parse_native_event};
use crate::translate::data::{fields, get, n_in, s_in};
use crate::translate::interactions::store_resolution;
use crate::translate::projected::projected;
use crate::translate::state::{Out, StateError};
use crate::translate::translator::{
    AgentBack, AgentGone, Diagnostic, ItemUpsert, NoticeDraft, OwnedDatum, ProcessExited,
    ProcessStarted, Signal, Translator,
};
use ace_json::{Map, Value};
use indexmap::IndexMap;

impl Translator {
    /// One frame. `parsed` is the envelope the session already validated for
    /// this `sse` frame; without it the frame is validated here.
    pub(crate) fn frame(
        &mut self,
        channel: &str,
        dir: &str,
        envelope: &Value,
        parsed: Option<&NativeEvent<'_>>,
        now: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        // The frame's fields are the envelope's, read once.
        let data: &Map = fields(envelope);
        let state = &mut self.state;
        if channel == "clock" {
            return Ok(());
        }
        if channel == "interaction.resolving" || channel == "interaction.rejected" {
            let key = s_in(data, "key").to_owned();
            if channel == "interaction.resolving" {
                store_resolution(state, &key, get(data, "resolution"))?;
            } else if let Some(pending) = state.pending.get_mut(&key) {
                pending.resolution = None;
            }
            return Ok(());
        }
        if channel == "transport.activity" {
            out.fact(&Signal { typ: "signal" })?;
            return Ok(());
        }
        if channel == "mcp.readiness" {
            self.diagnostics.push(Diagnostic {
                typ: String::from("adapter.warning"),
                data: OwnedDatum::Owned(Value::Object({
                    let mut warning = Map::new();
                    warning.insert(
                        String::from("event"),
                        Value::from(String::from("mcp-readiness-unconfirmed")),
                    );
                    warning.insert(
                        String::from("detail"),
                        Value::from(String::from(
                            "OpenCode never registered ace's readiness plugin; the session opened without confirming ace's tools.",
                        )),
                    );
                    warning
                })),
            });
            return Ok(());
        }
        if channel == "agent.environment" && s_in(data, "type") == "stopped" {
            let session = s_in(data, "sessionID").to_owned();
            let agent = if state.agents.contains_key(&session) {
                session.clone()
            } else {
                state.root_key.clone()
            };
            let agent = state.key(&agent).to_owned();
            out.fact(&ItemUpsert {
                typ: "item.upsert",
                agent: &agent,
                item: format!("agent-environment:{session}"),
                draft: NoticeDraft {
                    typ: "notice",
                    complete: true,
                    level: "warning",
                    text: "ace stopped this subagent before it ran anything: it couldn't give it its thread's shell environment.",
                    detail: s_in(data, "message"),
                },
            })?;
            return Ok(());
        }
        if channel == "lifecycle" {
            return self.lifecycle(data, out);
        }
        if channel == "input.sending" {
            let id = s_in(data, "id").to_owned();
            if state.commands.len() >= 1024 && !state.commands.contains_key(&id) {
                return Err(StateError::Limit("command correlation"));
            }
            let command = s_in(data, "commandId").to_owned();
            if !command.is_empty() {
                state.commands.insert(id, command);
            }
            return Ok(());
        }
        if channel == "input.uncertain" {
            let id = s_in(data, "id").to_owned();
            let session = state.inputs.get(&id).cloned();
            if let Some(session) = session
                && !state.admitted.has(&id)
            {
                state.background(&format!("admission:{id}"), &session, "other", None, out)?;
            }
            return Ok(());
        }
        if channel == "input.rejected" {
            let id = s_in(data, "id").to_owned();
            state.inputs.shift_remove(&id);
            state.commands.shift_remove(&id);
            state.admission_pending.remove(&id);
            state.finish_background(&format!("admission:{id}"), "stopped", out)?;
            state.queue(out)?;
            return Ok(());
        }
        if channel == "http" {
            return self.http(dir, data, out);
        }
        if channel == "snapshot.message" {
            return self.snapshot_message(data, out);
        }
        if channel == "snapshot.info" {
            return self.snapshot_info(data, out);
        }
        if channel == "snapshot.active" {
            return self.snapshot_active(data, out);
        }
        if channel == "snapshot.interactions" {
            return self.snapshot_interactions(data, out);
        }
        if channel == "snapshot.inbox" {
            return self.snapshot_inbox(data, out);
        }
        if channel != "sse" {
            return Ok(());
        }
        match parsed {
            Some(event) => self.event(event, envelope, now, out),
            None => self.event(&parse_native_event(envelope)?, envelope, now, out),
        }
    }

    pub(crate) fn lifecycle(&mut self, data: &Map, out: &mut Out<'_>) -> Result<(), StateError> {
        let state = &mut self.state;
        match s_in(data, "type") {
            "ancestry.pending" => {
                let root = state.root_native.clone();
                state.background(s_in(data, "id"), &root, "other", None, out)
            }
            "ancestry.settled" => {
                state.settle_probed(out)?;
                let id = s_in(data, "id").to_owned();
                state.finish_background(&id, "completed", out)
            }
            "started" => out.fact(&ProcessStarted {
                typ: "process.started",
            }),
            "exited" => {
                state.pending = IndexMap::new();
                out.fact(&ProcessExited {
                    typ: "process.exited",
                    deliberate: matches!(data.get("deliberate"), Some(Value::Bool(true))),
                    message: s_in(data, "message"),
                })
            }
            "disconnected" | "resynced" => {
                let disconnected = s_in(data, "type") == "disconnected";
                state.disconnected = disconnected;
                let agents: Vec<String> = state.agents.keys().cloned().collect();
                for id in agents {
                    let agent = state.key(&id).to_owned();
                    if disconnected {
                        out.fact(&AgentGone {
                            typ: "agent.disconnected",
                            agent: &agent,
                        })?;
                    } else {
                        out.fact(&AgentBack {
                            typ: "agent.reconnected",
                            agent: &agent,
                        })?;
                    }
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub(crate) fn http(
        &mut self,
        dir: &str,
        data: &Map,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let path = s_in(data, "path");
        let path = path.split('?').next().unwrap_or("");
        let body = fields(get(data, "body"));
        if dir == "recv" && s_in(data, "method") == "POST" && path == "/api/session" {
            return self.state.seen(fields(get(body, "data")), out);
        }
        if let Some(prompt) = path
            .strip_prefix("/api/session/")
            .and_then(|rest| rest.strip_suffix("/prompt"))
            && !prompt.is_empty()
            && !prompt.contains('/')
        {
            if dir == "send" {
                let session = prompt.to_owned();
                let id = s_in(body, "id").to_owned();
                self.state
                    .triggers
                    .insert(session.clone(), String::from("user"));
                self.state.admission_pending.insert(id.clone());
                self.state.input(&id, &session, out)?;
                let mut message = body.clone();
                message.insert(String::from("type"), Value::from(String::from("user")));
                return projected(&mut self.state, &session, &Value::Object(message), out);
            }
            if dir == "recv" && n_in(data, "status") == 200.0 {
                let admitted = fields(get(body, "data"));
                let id = s_in(admitted, "id").to_owned();
                let session = prompt.to_owned();
                if s_in(admitted, "sessionID") == session
                    && self
                        .state
                        .inputs
                        .get(&id)
                        .is_some_and(|owner| *owner == session)
                    && !self.state.admitted.has(&id)
                {
                    self.state.admit(&id, &session, out)?;
                    self.state.queue(out)?;
                }
            }
        }
        // Admission and interrupt receipts never settle a turn.
        Ok(())
    }
}
