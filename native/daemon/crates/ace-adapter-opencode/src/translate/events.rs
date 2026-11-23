// SPDX-License-Identifier: Apache-2.0
//! SSE events (`translator.ts`: events). Durable cursors deliver exactly
//! once; execution, tool, interaction, and inbox events fold into facts.

use crate::translate::boundaries::{event_session, order_envelope, parse_native_event};
use crate::translate::data::{Num, fields, get, n_in, n_in_fb, retry_reason, s_in};
use crate::translate::interactions::interaction;
use crate::translate::projected::{TextLoc, synthetic_kind, text};
use crate::translate::state::{Out, StateError};
use crate::translate::tool::tool;
use crate::translate::translator::Translator;
use crate::translate::translator::{AgentGone, InputConsumed, InteractionExpired, MAX_SAFE, Retry};
use crate::translate::usage::{Model, session_usage, step_context};
use serde_json::{Map, Value};

impl Translator {
    #[allow(clippy::too_many_lines)]
    pub(crate) fn event(
        &mut self,
        envelope: &Value,
        now: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let event = parse_native_event(envelope)?;
        // Evidence embeds the envelope as `NativeEvent.parse` emits it:
        // schema keys first, the rest in arrival order.
        let ordered = order_envelope(envelope);
        let evidence = &ordered;
        let p = event.data;
        let typ = event.typ;
        let created = event.created;
        if let Some(durable) = &event.durable {
            let before = self.state.durable.get(durable.aggregate_id).copied();
            if before.is_some_and(|before| durable.seq <= before) {
                return Ok(());
            }
            self.state
                .durable
                .set(durable.aggregate_id.to_owned(), durable.seq);
        }
        if self.state.events.has(event.id) {
            return Ok(());
        }
        self.state.events.add(event.id);
        // OpenCode closed this location's services: permissions, forms and
        // shells are gone, and the session reconciles everything else from
        // snapshots before it is trusted again.
        if typ == "location.shutdown" {
            if let Some(location) = event.location {
                let directory = s_in(location, "directory").to_owned();
                let expired: Vec<String> = self
                    .state
                    .pending
                    .iter()
                    .filter(|(_, pending)| {
                        self.state
                            .agents
                            .get(&pending.session)
                            .is_some_and(|owner| owner.directory == directory)
                    })
                    .map(|(key, _)| key.to_owned())
                    .collect();
                for key in expired {
                    self.state.pending.shift_remove(&key);
                    out.fact(&InteractionExpired {
                        typ: "interaction.closed",
                        interaction: key,
                        state: "expired",
                    })?;
                }
                let gone: Vec<String> = self
                    .state
                    .agents
                    .iter()
                    .filter(|(_, owner)| owner.directory == directory)
                    .map(|(id, _)| id.to_owned())
                    .collect();
                for id in gone {
                    let agent = self.state.key(&id).to_owned();
                    out.fact(&AgentGone {
                        typ: "agent.disconnected",
                        agent: &agent,
                    })?;
                }
            }
            return Ok(());
        }
        if typ == "session.created" {
            return self.state.seen(p, out);
        }
        if typ == "shell.created" {
            return self.shell_created(p, out);
        }
        if typ == "shell.exited" || typ == "shell.deleted" {
            return self.shell_exited(typ, p, created.unwrap_or(MAX_SAFE), out);
        }
        let id = event_session(envelope);
        if !self.state.agents.contains_key(&id) {
            return Ok(());
        }
        let agent = self.state.key(&id).to_owned();
        if typ == "session.execution.started" {
            let turn = match &event.durable {
                Some(durable) => format!(
                    "execution:{id}:{}",
                    crate::translate::data::num_str(durable.seq)
                ),
                None => format!("execution:{id}:{}", event.id),
            };
            let started = !self.state.active.contains_key(&id) && !self.state.ended.has(&turn);
            self.state.start(&id, &turn, out)?;
            if started && let Some(created) = created {
                self.state.execution_created.insert(id, created);
            }
            return Ok(());
        }
        if typ == "session.execution.succeeded"
            || typ == "session.execution.failed"
            || typ == "session.execution.interrupted"
        {
            return self.state.end(
                &id,
                if typ.ends_with("succeeded") {
                    "completed"
                } else if typ.ends_with("failed") {
                    "failed"
                } else {
                    "interrupted"
                },
                Some(get(p, "error")),
                out,
            );
        }
        if typ.starts_with("session.text.") || typ.starts_with("session.reasoning.") {
            self.recovered(&id, typ, out)?;
            return text(
                &mut self.state,
                typ,
                &TextLoc {
                    session: &id,
                    message: s_in(p, "assistantMessageID"),
                    ordinal: n_in(p, "ordinal"),
                },
                p,
                evidence,
                out,
            );
        }
        if typ.starts_with("session.tool.") {
            if typ.ends_with("delta") {
                return Ok(());
            }
            self.recovered(&id, typ, out)?;
            return tool(
                &mut self.state,
                typ,
                &id,
                s_in(p, "assistantMessageID"),
                p,
                evidence,
                out,
            );
        }
        if typ.starts_with("permission.") || typ.starts_with("form.") {
            return interaction(&mut self.state, typ, p, evidence, out);
        }
        if typ == "session.inbox.enqueued" {
            return self.inbox_enqueued(&id, p, created.unwrap_or(-1.0), out);
        }
        if typ == "session.inbox.delivered" || typ == "session.inbox.cancelled" {
            return self.inbox_settled(typ, &id, p, created.unwrap_or(MAX_SAFE), out);
        }
        if typ == "session.synthetic" {
            return self.synthetic(&id, p, created, out);
        }
        if typ == "session.retry.scheduled" {
            self.retrying.insert(id.clone());
            let message = s_in(fields(get(p, "error")), "message").to_owned();
            let on = retry_reason(&message);
            out.fact(&Retry {
                typ: "retry",
                agent: &agent,
                on,
                attempt: Num(n_in(p, "attempt")),
                until: Num(now + 0.0f64.max(n_in(p, "at") - created.unwrap_or(0.0))),
                message: &message,
            })?;
            return Ok(());
        }
        if typ == "session.model.selected" {
            return self.state.select_model(&id, get(p, "model"), out);
        }
        if typ == "session.usage.updated" {
            let known = self
                .state
                .agents
                .get(&id)
                .and_then(|meta| meta.model.clone());
            let fresh = crate::translate::usage::qualified_model(get(p, "model"));
            let model = match fresh {
                Some(fresh) => Some(Model::Owned(fresh)),
                None => known.as_deref().map(Model::Borrowed),
            };
            if let Some(usage) = session_usage(self.state.key(&id), &id, model, p) {
                out.fact(&usage)?;
            }
            return Ok(());
        }
        if typ == "session.step.ended" {
            self.recovered(&id, typ, out)?;
            let known = self
                .state
                .agents
                .get(&id)
                .and_then(|meta| meta.model.clone());
            let fresh = crate::translate::usage::qualified_model(get(p, "model"));
            let model = match fresh {
                Some(fresh) => Some(Model::Owned(fresh)),
                None => known.as_deref().map(Model::Borrowed),
            };
            if let Some(sample) = step_context(self.state.key(&id), &id, model, p) {
                out.fact(&sample)?;
            }
            return Ok(());
        }
        if typ == "session.step.streamed" {
            return self.recovered(&id, typ, out);
        }
        Ok(())
    }

    pub(crate) fn shell_created(
        &mut self,
        p: &Map<String, Value>,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let info = fields(get(p, "info"));
        let id = s_in(info, "id").to_owned();
        let session = s_in(fields(get(info, "metadata")), "sessionID").to_owned();
        if !self.state.agents.contains_key(&session) {
            return Ok(());
        }
        if s_in(info, "status") != "running" {
            self.state.shells.shift_remove(&id);
            let wake = self.state.wake_shells.remove(&id);
            self.state.finish_background(
                &format!("shell:{id}"),
                if s_in(info, "status") == "killed" {
                    "stopped"
                } else if matches!(info.get("exit"), Some(Value::Number(exit)) if exit.as_f64() == Some(0.0))
                {
                    "completed"
                } else {
                    "failed"
                },
                out,
            )?;
            if wake {
                let created = n_in_fb(fields(get(info, "time")), "completed", MAX_SAFE);
                self.state.wake(&session, created, out)?;
            }
            return Ok(());
        }
        if self.state.shells.len() >= 2048 && !self.state.shells.contains_key(&id) {
            return Err(StateError::Limit("shell"));
        }
        self.state.shells.insert(id.clone(), session.clone());
        self.state
            .background(&format!("shell:{id}"), &session, "shell", None, out)
    }

    pub(crate) fn shell_exited(
        &mut self,
        typ: &str,
        p: &Map<String, Value>,
        created: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let id = s_in(p, "id").to_owned();
        let session = match self.state.shells.get(&id) {
            Some(session) => session.clone(),
            None => return Ok(()),
        };
        self.state.shells.shift_remove(&id);
        let wake = self.state.wake_shells.remove(&id);
        self.state.finish_background(
            &format!("shell:{id}"),
            if typ == "shell.deleted" || s_in(p, "status") == "killed" {
                "stopped"
            } else if matches!(p.get("exit"), Some(Value::Number(exit)) if exit.as_f64() == Some(0.0)) {
                "completed"
            } else {
                "failed"
            },
            out,
        )?;
        if wake {
            self.state.wake(&session, created, out)?;
        }
        Ok(())
    }

    pub(crate) fn inbox_enqueued(
        &mut self,
        id: &str,
        p: &Map<String, Value>,
        created: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let input = s_in(p, "inboxID").to_owned();
        let own = self.state.admission_pending.remove(&input);
        if own && !self.state.admitted.has(&input) {
            self.state.admit(&input, id, out)?;
        }
        self.state.input(&input, id, out)?;
        let item = fields(get(p, "item"));
        if s_in(item, "type") == "synthetic" {
            let metadata = fields(get(fields(get(item, "payload")), "metadata"));
            self.state.triggers.insert(
                id.to_owned(),
                synthetic_kind(metadata)
                    .map(String::from)
                    .unwrap_or_else(|| String::from("background_completion")),
            );
            self.state.completion(metadata, created, out)?;
        }
        Ok(())
    }

    pub(crate) fn inbox_settled(
        &mut self,
        typ: &str,
        id: &str,
        p: &Map<String, Value>,
        created: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let inbox = s_in(p, "inboxID").to_owned();
        if self.state.admission_pending.contains(&inbox) {
            self.state.admit(&inbox, id, out)?;
        }
        self.state.inputs.shift_remove(&inbox);
        self.state.commands.shift_remove(&inbox);
        self.state.admission_pending.remove(&inbox);
        self.state
            .finish_background(&format!("admission:{inbox}"), "completed", out)?;
        self.state.queue(out)?;
        if typ.ends_with("delivered") {
            if self.state.active.contains_key(id) {
                self.state.reconcile_wake(id, created, out)?;
            } else {
                self.state.wake(id, created, out)?;
            }
            // Delivery moves the input into the session's running execution,
            // or with none running, starts the next one.
            if !inbox.is_empty() {
                let agent = self.state.key(id).to_owned();
                out.fact(&InputConsumed {
                    typ: "input.consumed",
                    agent: &agent,
                    native_input_ids: vec![inbox.as_str()],
                })?;
            }
        }
        Ok(())
    }

    pub(crate) fn synthetic(
        &mut self,
        id: &str,
        p: &Map<String, Value>,
        created: Option<f64>,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let meta = fields(get(p, "metadata"));
        // A synthetic message that lands inside a live execution is consumed
        // by that execution. Only one that arrives while the session is idle
        // wakes it.
        if self.state.active.contains_key(id) {
            return self.state.completion(meta, created.unwrap_or(-1.0), out);
        }
        self.state.triggers.insert(
            id.to_owned(),
            synthetic_kind(meta)
                .map(String::from)
                .unwrap_or_else(|| String::from("background_completion")),
        );
        self.state.completion(meta, created.unwrap_or(-1.0), out)?;
        self.state.wake(id, created.unwrap_or(MAX_SAFE), out)
    }
}
