// SPDX-License-Identifier: Apache-2.0
//! The effects one input decided: their order, their one-step publication,
//! and the launch path that turns a permission mode into options.

use super::*;

impl SessionChannel {
    /// Every effect one input decided, carried in order, and handed to the
    /// queue in one step: nothing another input publishes can land between
    /// two of them (ADR 0223 §7 rule 3).
    pub(super) fn apply(&self, effects: Vec<Effect>) {
        let mut events = Vec::new();
        self.apply_into(effects, &mut events);
        self.publish(events);
    }

    /// Hands the effects decided so far to the queue before this input talks
    /// to the host again: a callback that input provokes must not publish
    /// ahead of the frames it already decided.
    fn flush_events(&self, events: &mut Vec<SessionEvent>) {
        if !events.is_empty() {
            self.publish(std::mem::take(events));
        }
    }

    fn apply_into(&self, effects: Vec<Effect>, events: &mut Vec<SessionEvent>) {
        for effect in effects {
            match effect {
                Effect::Frame { dir, channel, text } => events.push(SessionEvent::Frame {
                    seq: 0,
                    dir,
                    channel: channel.to_owned(),
                    text,
                }),
                Effect::Callback { name, json } => {
                    events.push(SessionEvent::Callback { name, json });
                }
                Effect::Settle { id, result } => self.settle_result_into(id, result, events),
                Effect::ArmTimer { key, ms } => {
                    events.push(SessionEvent::ArmTimer { key, ms });
                }
                Effect::CancelTimer { key } => {
                    events.push(SessionEvent::CancelTimer { key });
                }
                Effect::Exited {
                    deliberate,
                    message,
                } => {
                    let mut result = Map::new();
                    result.insert("deliberate", Value::Bool(deliberate));
                    result.insert("message", Value::from(message));
                    events.push(SessionEvent::Callback {
                        name: "onExit",
                        json: Value::Array(ace_json::Array::from(vec![Value::Object(result)]))
                            .to_json(),
                    });
                }
                Effect::Closed(result) => {
                    let operation = self.core().close_operation.take();
                    if let Some(operation) = operation {
                        match result {
                            Ok(()) => {
                                self.settle_operation_into(operation, Ok(Value::Null), events);
                                self.finish_drained_into(events);
                            }
                            Err(message) => self.settle_operation_into(
                                operation,
                                Err(crate::session::frames::Failure::failed(message)),
                                events,
                            ),
                        }
                    }
                }
                Effect::Cleanup => {
                    let effects = {
                        let mut core = self.core();
                        core.session.cleanup()
                    };
                    self.apply_into(effects, events);
                }
                Effect::Request {
                    call,
                    method,
                    params,
                    timeout_ms,
                } => {
                    let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
                    self.flush_events(events);
                    let owner = self.owner_for(call);
                    if let Ok(mut owners) = self.shared.owners.lock() {
                        owners.insert(id, owner);
                    }
                    let timeout = match timeout_ms {
                        Some(ms) => Timeout::After(ms),
                        None => Timeout::Disabled,
                    };
                    if let Err(error) =
                        self.shared
                            .host
                            .request(self.tenant, &method, Some(&params), id, timeout)
                    {
                        if let Ok(mut owners) = self.shared.owners.lock() {
                            owners.shift_remove(&id);
                        }
                        let message = error.to_string();
                        let effects = {
                            let mut core = self.core();
                            core.session.settled(call, Err(&message))
                        };
                        self.apply_into(effects, events);
                    }
                }
                Effect::ReadHistory { call, thread } => {
                    let effects = {
                        let mut core = self.core();
                        let (read, effects) = HistoryRead::start(&thread, &mut core.session.calls);
                        core.jobs.histories.insert(call, HistoryJob { read });
                        effects
                    };
                    self.apply_into(effects, events);
                }
                Effect::WakeCatalog { wake, catalog } => {
                    let effects = {
                        let mut core = self.core();
                        let operation = core
                            .jobs
                            .facts
                            .iter()
                            .find(|(_, job)| job.wake == wake)
                            .map(|(operation, _)| *operation);
                        match operation {
                            Some(operation) => core
                                .jobs
                                .facts
                                .get_mut(&operation)
                                .map(|job| job.read.catalog_ready(catalog))
                                .unwrap_or_default(),
                            None => Vec::new(),
                        }
                    };
                    self.apply_into(effects, events);
                }
                Effect::Answer { id, result } => {
                    self.flush_events(events);
                    self.shared.host.answer(&id, &result);
                }
                Effect::AnswerError { id, message } => {
                    self.flush_events(events);
                    self.shared.host.answer_error(&id, INTERNAL_ERROR, &message)
                }
                Effect::LaunchOptions { id, thread } => {
                    self.flush_events(events);
                    self.launch_into(id, &thread, events);
                }
                Effect::Retire { reason } => {
                    self.flush_events(events);
                    if let Ok(mut slot) = self.shared.retire_channel.lock()
                        && slot.is_none()
                    {
                        *slot = self.shared.channel(self.tenant);
                    }
                    self.shared.host.retire(reason)
                }
                Effect::StopWork { reason } => {
                    self.flush_events(events);
                    let operation = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
                    let _ = reason;
                    let effects = {
                        let mut core = self.core();
                        core.work_operation = Some(operation);
                        core.session.interrupt(operation, Some("root"), true)
                    };
                    self.apply_into(effects, events);
                }
                Effect::Detach { reason, message } => {
                    self.flush_events(events);
                    self.shared
                        .host
                        .detach_passive(self.tenant, reason, &message)
                }
                Effect::FailTransport => {}
            }
        }
        self.settle_finished_reads_into(events);
    }

    /// Which machine asked for one session-local call: a history page, tool
    /// facts, the usage read, or the session's own command.
    fn owner_for(&self, call: u64) -> Owner {
        let core = self.core();
        if let Some((operation, _)) = core
            .jobs
            .facts
            .iter()
            .find(|(_, job)| job.read.awaits(call))
        {
            return Owner::FactsLocal {
                tenant: self.tenant,
                operation: *operation,
                call,
            };
        }
        if core
            .jobs
            .rate
            .as_ref()
            .is_some_and(|read| read.call() == call)
        {
            return Owner::RateLimits {
                tenant: self.tenant,
                call,
            };
        }
        // A history page's call belongs to the only job waiting on it.
        if let Some((discovery, _)) = core
            .jobs
            .histories
            .iter()
            .find(|(_, job)| job.read.awaits(call))
        {
            return Owner::History {
                tenant: self.tenant,
                discovery: *discovery,
            };
        }
        Owner::SessionCall {
            tenant: self.tenant,
            call,
        }
    }

    fn settle_result_into(
        &self,
        id: u64,
        result: Result<Value, crate::session::frames::Failure>,
        events: &mut Vec<SessionEvent>,
    ) {
        let work = {
            let mut core = self.core();
            if core.work_operation == Some(id) {
                core.work_operation = None;
                true
            } else {
                false
            }
        };
        if !work {
            self.settle_operation_into(id, result, events);
            return;
        }
        let outcome = result.map(|_| ()).map_err(|failure| failure.message);
        let effects = {
            let mut core = self.core();
            core.session.lifetime.work_stopped(outcome)
        };
        self.apply_into(effects, events);
    }

    fn launch_into(&self, operation: u64, thread: &str, events: &mut Vec<SessionEvent>) {
        let (mode, applied, port) = {
            let core = self.core();
            (
                core.session.permission_mode.clone(),
                core.session.applied_permission_mode.clone(),
                core.permission_port,
            )
        };
        if port {
            events.push(SessionEvent::Port {
                name: "launch",
                json: format!(
                    "{{\"operation\":{operation},\"thread\":{}}}",
                    Value::from(thread.to_owned()).to_json()
                ),
            });
            return;
        }
        if mode.is_none() && applied.is_some() {
            self.launch_config_read(operation);
            return;
        }
        let effects = {
            let mut core = self.core();
            let policy = codex_turn_policy(mode.as_deref()).unwrap_or_default();
            let options = with_selection(policy, &core.selection);
            core.session
                .launch_ready(operation, Ok(Launch { mode, options }))
        };
        self.apply_into(effects, events);
    }

    /// The context's permission mode could not be read: the start fails.
    pub fn launch_failed(&self, operation: u64, message: &str) {
        let effects = {
            let mut core = self.core();
            core.session
                .launch_ready(operation, Err(message.to_owned()))
        };
        self.apply(effects);
    }

    /// The context's permission mode, from the facade's port.
    pub fn launch_mode(&self, operation: u64, mode_json: &str) {
        let mode = match ace_json::parse(mode_json) {
            Ok(Value::String(text)) => Some(text.as_str().to_owned()),
            _ => None,
        };
        let applied = {
            let mut core = self.core();
            core.session.permission_mode = mode.clone();
            core.session.applied_permission_mode.clone()
        };
        if mode.is_none() && applied.is_some() {
            self.launch_config_read(operation);
            return;
        }
        let effects = {
            let mut core = self.core();
            let policy = codex_turn_policy(mode.as_deref()).unwrap_or_default();
            let options = with_selection(policy, &core.selection);
            core.session
                .launch_ready(operation, Ok(Launch { mode, options }))
        };
        self.apply(effects);
    }

    fn launch_config_read(&self, operation: u64) {
        let call = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut owners) = self.shared.owners.lock() {
            owners.insert(
                call,
                Owner::LaunchConfig {
                    tenant: self.tenant,
                    operation,
                },
            );
        }
        let mut params = Map::new();
        params.insert("cwd", Value::from(self.cwd.clone()));
        params.insert("includeLayers", Value::Bool(false));
        if let Err(error) = self.shared.host.request(
            self.tenant,
            "config/read",
            Some(&Value::Object(params)),
            call,
            Timeout::After(30_000.0),
        ) {
            let effects = {
                let mut core = self.core();
                core.session.launch_ready(operation, Err(error.to_string()))
            };
            self.apply(effects);
        }
    }
}
