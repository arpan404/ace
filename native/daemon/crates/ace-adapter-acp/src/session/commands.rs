// SPDX-License-Identifier: Apache-2.0
//! ACP's commands besides prompts: interrupts, selections and the close
//! (`packages/adapter-acp/src/session.ts:536`-`:590`, `:856`-`:940`).

use ace_adapter_api::session::{CloseReason, InterruptTarget};
use ace_json::{Map, Value};

use super::core::{AcpCore, AcpEffect, AcpErrorWire};
use super::protocol::agent_methods;
use super::selectors::SelectorKind;
use crate::translate::keys::native_agent_key;
use crate::translate::settlement::CANCELLATION_GRACE_MS;

/// One selection a command asked for, in the order asked (`session.ts:535`).
#[derive(Debug)]
pub(crate) struct QueuedSelection {
    pub operation: u64,
    pub kind: SelectorKind,
    pub value: String,
    /// `setMode`'s own bookkeeping: a model's reply that resets it gets it back, and a
    /// refused restore only announces (`session.ts:572`-`:590`).
    pub wanted_mode: bool,
    pub before_mode: Option<String>,
    /// A mode restored after a model's reply: a failure only announces
    /// (`session.ts:577`-`:584`).
    pub swallow: bool,
}

impl AcpCore {
    /// `interrupt` (`session.ts:856`): cancel the agent's turn, or one child's, with the
    /// questions its target answered.
    pub fn interrupt(
        &mut self,
        target: InterruptTarget,
        effects: &mut Vec<AcpEffect>,
    ) -> Result<(), AcpErrorWire> {
        if self.closed {
            return Err(AcpErrorWire::rpc_error("ACP session closed"));
        }
        let agent_key = target.agent.as_ref().map(|key| key.as_str().to_owned());
        let child = agent_key
            .as_deref()
            .and_then(|key| self.routing.by_key(key).cloned());
        if let Some(key) = agent_key.as_deref()
            && child.is_none()
            && key != "root"
            && key != native_agent_key(self.routing.thread_id(), &self.native_session_id).as_str()
        {
            return Err(AcpErrorWire::rpc_error("Unknown ACP agent key"));
        }
        if child.as_ref().is_some_and(|child| !child.cancel) {
            return Err(AcpErrorWire::rpc_error(
                "ACP child does not permit cancellation",
            ));
        }
        let id = child
            .as_ref()
            .map(|child| child.id.clone())
            .unwrap_or_else(|| self.native_session_id.clone());
        let descendants = if target.cascade {
            self.routing.descendants(&id)
        } else {
            Vec::new()
        };
        let mut owners = std::collections::HashSet::with_capacity(descendants.len() + 1);
        owners.insert(id.clone());
        for descendant in &descendants {
            owners.insert(descendant.id.clone());
        }
        self.cancel_questions(Some(&owners), None, effects);
        // `notify(...).catch(() => {})` (`session.ts:871`): a cancel the transport could
        // not carry still arms the grace deadlines below.
        // `notify(...).catch(() => {})` (`session.ts:871`): a cancel the transport could
        // not carry still arms the grace deadlines below.
        if let Ok(notified) = self.notify(agent_methods::SESSION_CANCEL, Some(&cancel_params(&id)))
        {
            effects.extend(notified);
        }
        if let Some(child) = &child {
            // A child that goes silent after its cancel is given up as interrupted, as the
            // translator does at the same deadline (`session.ts:872`-`:876`).
            let mut cancelled = vec![child.clone()];
            cancelled.extend(descendants.iter().cloned());
            for child in &cancelled {
                if child.live && child.cancel {
                    self.expire_after_grace(&child.id, effects);
                }
            }
        } else if self.prompt_id.is_some() && !self.deadlines.has("root") {
            // A stop the agent never answers would hang the thread: recover by restarting.
            self.arm_deadline("root", CANCELLATION_GRACE_MS as f64, effects);
        }
        for descendant in &descendants {
            if descendant.live
                && descendant.cancel
                && let Ok(notified) = self.notify(
                    agent_methods::SESSION_CANCEL,
                    Some(&cancel_params(&descendant.id)),
                )
            {
                effects.extend(notified);
            }
        }
        Ok(())
    }

    /// `expireAfterGrace` (`session.ts:888`): a child that never reports its end stops
    /// holding input at the same deadline the translator gives up at.
    fn expire_after_grace(&mut self, id: &ace_json::JsString, effects: &mut Vec<AcpEffect>) {
        self.cancelling_children.insert(id.clone());
        self.arm_deadline(
            &format!("child:{id}"),
            CANCELLATION_GRACE_MS as f64,
            effects,
        );
    }

    /// `stopTask` (`session.ts:898`): ACP has no per-task control.
    pub fn stop_task(&mut self, _task: &str) -> Result<(), AcpErrorWire> {
        Err(AcpErrorWire::rpc_error(
            "ACP does not expose individual background task control",
        ))
    }

    /// `setModel` (`session.ts:572`): a selection, then the mode it may have reset. Only a
    /// closed session refuses at once (`:537`); whether the session is settled is checked
    /// when the selection runs (`:542`-`:551`, `selectNow`).
    pub fn set_model(&mut self, operation: u64, model: &str, effects: &mut Vec<AcpEffect>) {
        let queued = QueuedSelection {
            operation,
            kind: SelectorKind::Model,
            value: model.to_owned(),
            wanted_mode: false,
            before_mode: self.configuration.current(SelectorKind::Mode),
            swallow: false,
        };
        self.selection_queue.push_back(queued);
        self.pump_selections(effects);
    }

    /// `setMode` (`session.ts:587`): a mode may change at any time, a running turn included.
    pub fn set_mode(&mut self, operation: u64, mode: &str, effects: &mut Vec<AcpEffect>) {
        if self.closed {
            effects.push(AcpEffect::Settle {
                id: operation,
                result: Err(AcpErrorWire::rpc_error(
                    "ACP selectors require a settled session",
                )),
            });
            return;
        }
        let queued = QueuedSelection {
            operation,
            kind: SelectorKind::Mode,
            value: mode.to_owned(),
            wanted_mode: true,
            before_mode: None,
            swallow: false,
        };
        self.selection_queue.push_back(queued);
        self.pump_selections(effects);
    }

    /// `selectNow`'s guard (`session.ts:542`-`:551`): model and effort change only
    /// between turns; a mode may always change.
    fn assert_selectable(&self, kind: SelectorKind) -> Result<(), AcpErrorWire> {
        if self.closed {
            return Err(AcpErrorWire::rpc_error(
                "ACP selectors require a settled session",
            ));
        }
        if kind != SelectorKind::Mode
            && (self.active
                || self.routing.has_live_children()
                || !self.pending.is_empty()
                || self.shells.blocked())
        {
            return Err(AcpErrorWire::rpc_error(
                "ACP selectors require a settled session",
            ));
        }
        Ok(())
    }

    /// One selection at a time, in the order asked (`session.ts:534`-`:540`).
    pub(crate) fn pump_selections(&mut self, effects: &mut Vec<AcpEffect>) {
        if self.selection_flight.is_some() {
            return;
        }
        let Some(next) = self.selection_queue.pop_front() else {
            self.selecting = false;
            self.drain(effects);
            return;
        };
        // `selectNow`'s guard: model and effort change only between turns, and the check
        // happens when this selection runs, not when it was asked for (`:542`-`:551`).
        if let Err(error) = self.assert_selectable(next.kind) {
            effects.push(AcpEffect::Settle {
                id: next.operation,
                result: Err(error),
            });
            self.pump_selections(effects);
            return;
        }
        if self.closed {
            effects.push(AcpEffect::Settle {
                id: next.operation,
                result: Err(AcpErrorWire::rpc_error(
                    "ACP selectors require a settled session",
                )),
            });
            self.pump_selections(effects);
            return;
        }
        self.selecting = true;
        let prepared = self.configuration.prepare_select(
            next.kind,
            &next.value,
            self.native_session_id.as_str(),
        );
        let pending = match prepared {
            Ok(pending) => pending,
            Err(err) => {
                effects.push(AcpEffect::Settle {
                    id: next.operation,
                    result: Err(AcpErrorWire::rpc_error(err.to_string())),
                });
                self.pump_selections(effects);
                return;
            }
        };
        let method = pending.request.method.clone();
        let params = Value::Object(pending.request.params.clone());
        let call = self.alloc_internal_id();
        let flight = SelectionFlight {
            call,
            next,
            pending,
        };
        match self.peer.request(
            &method,
            Some(&params),
            call,
            ace_supervisor::peer::Timeout::Default,
        ) {
            Ok(peer_effects) => {
                self.selection_flight = Some(flight);
                self.apply_peer_effects(peer_effects, effects);
            }
            Err(err) => {
                let operation = flight.next.operation;
                effects.push(AcpEffect::Settle {
                    id: operation,
                    result: Err(AcpErrorWire::rpc_error(err.message().to_owned())),
                });
                self.pump_selections(effects);
            }
        }
    }

    /// One selection's reply (`session.ts:552`-`:568`, `:572`-`:590`).
    pub(crate) fn finish_selection(
        &mut self,
        call: u64,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) -> bool {
        let Some(flight) = self
            .selection_flight
            .take()
            .filter(|flight| flight.call == call)
        else {
            return false;
        };
        let SelectionFlight { next, pending, .. } = flight;
        let mut settle: Option<Result<String, AcpErrorWire>> = None;
        match result {
            Ok(reply) => {
                let (cfg, outcome) = self.configuration.apply_select_reply(&pending, &reply);
                self.push_config_effects(cfg, effects);
                match outcome {
                    Ok(()) => {
                        if next.wanted_mode {
                            self.wanted_mode = Some(next.value.clone());
                        }
                        if !(next.kind == SelectorKind::Model && self.mode_restore(&next, effects))
                        {
                            settle = Some(Ok(Value::Null.to_json()));
                        }
                    }
                    Err(err) => {
                        self.report_selection_error(&err, &pending, effects);
                        if next.swallow {
                            // A refused restore falls through to announceMode.
                            self.announce_running_mode(effects);
                            settle = Some(Ok(Value::Null.to_json()));
                        } else {
                            settle = Some(Err(AcpErrorWire::rpc_error(err.to_string())));
                        }
                    }
                }
            }
            Err(message) => {
                let (cfg, err) = self.configuration.apply_select_error(&pending, &message);
                self.push_config_effects(cfg, effects);
                self.report_selection_error(&err, &pending, effects);
                if message.contains("request timed out") {
                    // A selection that never answered ends the session (`session.ts:555`).
                    self.fail(&self.redact_message(&message), effects);
                }
                if next.swallow {
                    self.announce_running_mode(effects);
                    settle = Some(Ok(Value::Null.to_json()));
                } else {
                    settle = Some(Err(AcpErrorWire::rpc_error(self.redact_message(&message))));
                }
            }
        }
        if let Some(result) = settle {
            effects.push(AcpEffect::Settle {
                id: next.operation,
                result,
            });
        }
        self.pump_selections(effects);
        true
    }

    /// `setModel`'s tail (`session.ts:574`-`:586`): a model's reply that moved the mode
    /// either gets the wanted mode back or the daemon hears what runs. True when a
    /// restore was queued, so the send's promise waits for it.
    fn mode_restore(&mut self, next: &QueuedSelection, effects: &mut Vec<AcpEffect>) -> bool {
        let now = self.configuration.current(SelectorKind::Mode);
        if now == next.before_mode {
            return false;
        }
        match &self.wanted_mode {
            Some(wanted) if now.as_deref() != Some(wanted.as_str()) => {
                // TS chains the restore behind whatever is already queued (`:538`): the
                // `selections` promise it extends is the tail, not the head.
                self.selection_queue.push_back(QueuedSelection {
                    operation: next.operation,
                    kind: SelectorKind::Mode,
                    value: wanted.clone(),
                    wanted_mode: false,
                    before_mode: None,
                    swallow: true,
                });
                true
            }
            _ => {
                self.announce_running_mode(effects);
                false
            }
        }
    }

    /// `close` (`session.ts:901`-`:920`): a deliberate stop, unless a fault caused it.
    /// The process itself is the shell's stop, and the Windows tree stop stays TypeScript.
    pub fn close(&mut self, _reason: CloseReason, effects: &mut Vec<AcpEffect>) {
        if self.fault.is_none() && !self.process_exited {
            self.deliberate = true;
        }
        if !self.closed {
            self.closed = true;
            self.clear_all_deadlines(effects);
            let mut note = Map::with_capacity(1);
            note.insert("event", Value::from("stop"));
            self.emit_note("recorder", Value::Object(note), effects);
            self.cancel_questions(None, None, effects);
            self.reject_queue("ACP session closed", effects);
        }
        // `ctx.mcp?.end()` (`session.ts:912`): the lease goes with the session. The facade
        // owns the lease, so it hears it as a context callback.
        self.end_lease(effects);
        // The peer is not closed here: TS's `rpc.close()` follows the stop (`:914`-`:919`),
        // so the frames a child sends on SIGTERM still arrive. `finish` closes it at the
        // pipe barrier.
    }
}

/// A selection awaiting its reply (`session.ts:552`).
#[derive(Debug)]
pub(crate) struct SelectionFlight {
    pub call: u64,
    pub next: QueuedSelection,
    pub pending: super::configuration::PendingSelection,
}

fn cancel_params(session_id: &ace_json::JsString) -> Value {
    let mut params = Map::with_capacity(1);
    params.insert("sessionId", Value::String(session_id.clone()));
    Value::Object(params)
}
