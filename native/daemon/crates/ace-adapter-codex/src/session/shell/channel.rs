// SPDX-License-Identifier: Apache-2.0
//! One session's channel: the facade's calls, the host's callbacks and the
//! ordered effects they decide.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use ace_adapter_api::bridge::ReadGate;
use ace_adapter_api::bridge::queue::{EventQueue, SessionErrorWire, SessionEvent};
use ace_adapter_api::session::{Delivery, InputSource, SteerFence};
use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::{Direction, INTERNAL_ERROR, Timeout};

use crate::session::commands::{Answer, Launch, Send as SendInput};
use crate::session::frames::{Effect, FrameDir};
use crate::session::history::{HistoryRead, history_notes};
use crate::session::host::{
    Admission, ChannelHandlers, DroppedLine, HostExit, RequestAnswer, Retirement,
};
use crate::session::permissions::{codex_turn_policy, configured_turn_policy};
use crate::session::selection::{Selection, parse_selection, selection_options};
use crate::session::state::Session;
use crate::session::terminals::RateLimitsRead;
use crate::session::tools::CodexToolFacts;
use crate::session::tools::read::{ToolFactsOutcome, ToolFactsRead};

use super::host::{HostShell, Owner, SharedHost};

mod construct;
mod effects;
mod handlers;

/// One session's channel on a host: its state, its ordered queue and the
/// facade's calls.
pub struct SessionChannel {
    pub tenant: u64,
    shared: Arc<SharedHost>,
    stop: Arc<dyn Fn(String) + Send + Sync>,
    cwd: String,
    core: Mutex<Core>,
    queue: EventQueue,
    gate: ReadGate,
    now: Mutex<f64>,
    /// The spawn's `maxLineBytes`, shared with the diverted consumer.
    line_limit: Arc<AtomicUsize>,
    /// The session's admission inputs, so the host can vet a frame without the
    /// core lock (the host holds its own lock when it asks).
    bearer: Option<String>,
    drained: AtomicBool,
}

struct Core {
    session: Session,
    jobs: Jobs,
    model: String,
    selection: Selection,
    open_operation: Option<u64>,
    opened: bool,
    close_operation: Option<u64>,
    work_operation: Option<u64>,
    permission_port: bool,
    /// Opens waiting for the resumed thread's history to land.
    read_operations: Vec<u64>,
}

#[derive(Default)]
struct Jobs {
    histories: indexmap::IndexMap<u64, HistoryJob>,
    facts: indexmap::IndexMap<u64, FactsJob>,
    rate: Option<RateLimitsRead>,
}

struct HistoryJob {
    read: HistoryRead,
}

struct FactsJob {
    read: ToolFactsRead,
    wake: u64,
}

impl SessionChannel {
    pub fn queue(&self) -> EventQueue {
        self.queue.clone()
    }

    pub fn gate(&self) -> ReadGate {
        self.gate.clone()
    }

    pub fn line_limit(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.line_limit)
    }

    /// The engine's `outputFlow` pause: stop this tenant's pumps through the
    /// host gate, which is the gate the diverted child actually answers.
    pub fn set_paused(&self, paused: bool) {
        self.shared.host.set_paused(self.tenant, paused);
    }

    /// A commit failed: stop intake for good.
    pub fn fail_intake(&self) {
        self.shared.host.gate().fail();
    }

    /// The queue dropped back under its bound: let the pumps read again.
    pub fn queue_consumed(&self) {
        self.shared.host.gate().set_backlog(self.queue.at_bound());
    }

    /// The terminal barrier: every event before it is already on the queue.
    pub fn finish_drained(&self) {
        let mut events = Vec::new();
        self.finish_drained_into(&mut events);
        self.publish(events);
    }

    /// `Drained`, once, appended to the events its input already decided.
    fn finish_drained_into(&self, events: &mut Vec<SessionEvent>) {
        if self.drained.swap(true, Ordering::SeqCst) {
            return;
        }
        events.push(SessionEvent::Drained);
    }

    pub fn set_now(&self, now: f64) {
        if let Ok(mut current) = self.now.lock() {
            *current = now;
        }
    }

    fn now(&self) -> f64 {
        self.now.lock().map(|now| *now).unwrap_or_default()
    }

    fn core(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn publish(&self, events: Vec<SessionEvent>) {
        if !events.is_empty() {
            self.queue.publish(events);
            // A stalled facade fills this session's queue; stop the child's
            // pumps until it has taken a batch (E3.0c rule 4, same as TS's
            // outputFlow).
            self.shared.host.gate().set_backlog(self.queue.at_bound());
        }
    }

    pub fn publish_port(&self, name: &'static str, json: String) {
        self.publish(vec![SessionEvent::Port { name, json }]);
    }

    pub(super) fn publish_settle(
        &self,
        operation: u64,
        result: Result<Value, ace_supervisor::peer::PeerError>,
    ) {
        let event = match result {
            Ok(value) => SessionEvent::Settle {
                id: operation,
                result: Ok(value.to_json()),
            },
            Err(error) => SessionEvent::Settle {
                id: operation,
                result: Err(SessionErrorWire {
                    code: "ACE_CODEX_FAILED",
                    message: error.message().to_owned(),
                }),
            },
        };
        self.publish(vec![event]);
    }

    fn settle_operation(
        &self,
        operation: u64,
        result: Result<Value, crate::session::frames::Failure>,
    ) {
        let mut events = Vec::new();
        self.settle_operation_into(operation, result, &mut events);
        self.publish(events);
    }

    /// The settlement, appended to the events its input already decided.
    fn settle_operation_into(
        &self,
        operation: u64,
        result: Result<Value, crate::session::frames::Failure>,
        events: &mut Vec<SessionEvent>,
    ) {
        let event = match result {
            Ok(value) => SessionEvent::Settle {
                id: operation,
                result: Ok(value.to_json()),
            },
            Err(failure) => SessionEvent::Settle {
                id: operation,
                result: Err(SessionErrorWire {
                    code: failure.code,
                    message: failure.message,
                }),
            },
        };
        events.push(event);
    }

    /// A facade request's id: one host id space, so no two promises collide.
    pub fn allocate_operation(&self) -> u64 {
        self.shared.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// The open's promise: `Opened` may already have arrived on a reused host.
    pub fn ready(&self) -> u64 {
        let operation = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut owners) = self.shared.owners.lock() {
            owners.insert(
                operation,
                Owner::Js {
                    tenant: self.tenant,
                    operation,
                },
            );
        }
        let opened = {
            let mut core = self.core();
            core.open_operation = Some(operation);
            core.opened
        };
        if opened {
            self.settle_operation(operation, Ok(Value::Null));
        }
        operation
    }

    /// `spawned(pid)`: the child exists; the host may publish.
    pub fn spawned(&self, pid: u32) {
        self.shared.host.set_pid(pid);
        if let Some(ports) = self.shared.ports.get() {
            self.shared.host.gate().attach(ports.output.clone());
        }
        let shell = HostShell::new(Arc::clone(&self.shared), Arc::clone(&self.stop));
        self.shared.host.set_sink(shell);
    }

    pub(super) fn open_failed(&self, message: &str) {
        let operation = { self.core().open_operation.take() };
        if let Some(operation) = operation {
            self.publish(vec![SessionEvent::Settle {
                id: operation,
                result: Err(SessionErrorWire {
                    code: "ACE_CODEX_FAILED",
                    message: message.to_owned(),
                }),
            }]);
        }
    }

    pub(super) fn open_ready(&self) {
        let operation = {
            let mut core = self.core();
            core.opened = true;
            core.open_operation
        };
        if let Some(operation) = operation {
            self.settle_operation(operation, Ok(Value::Null));
        }
    }

    pub fn permission_mode_port(&self, present: bool) {
        self.core().permission_port = present;
    }

    /// `attached(root, model, selection, permissionMode)`.
    pub fn attached(
        &self,
        root: &str,
        model: &str,
        selection_json: &str,
        permission_mode: Option<&str>,
    ) {
        let selection = match ace_json::parse(selection_json) {
            Ok(value) => parse_selection(&value).unwrap_or_default(),
            Err(_) => Selection::default(),
        };
        let shared = !self.shared.host.dedicated();
        let alone = self.shared.host.alone(self.tenant);
        let mut core = self.core();
        core.session.attached(root, shared, alone);
        core.model = model.to_owned();
        core.selection = selection;
        core.session.permission_mode = permission_mode.map(str::to_owned);
        core.session.applied_permission_mode = core.session.permission_mode.clone();
    }

    pub fn note(&self, json: &str) {
        let Ok(value) = ace_json::parse(json) else {
            return;
        };
        let effects = {
            let mut core = self.core();
            core.session.emit_note(&value)
        };
        self.apply(effects);
    }

    fn frame(&self, dir: Direction, data: &Value) {
        let now = self.now();
        let effects = {
            let mut core = self.core();
            let optional_dir = match dir {
                Direction::Send => FrameDir::Send,
                Direction::Recv => FrameDir::Recv,
            };
            let optional = core.session.optional_frame(optional_dir, data);
            core.session.frame(dir, data, optional.as_deref(), now)
        };
        self.apply(effects);
    }

    pub(super) fn settled_call(&self, call: u64, reply: Result<&Value, &str>) {
        let effects = {
            let mut core = self.core();
            core.session.settled(call, reply)
        };
        self.apply(effects);
    }

    pub(super) fn history_settled(&self, discovery: u64, reply: Result<&Value, &str>) {
        let (effects, outcome) = {
            let mut core = self.core();
            let Core { session, jobs, .. } = &mut *core;
            let Some(job) = jobs.histories.get_mut(&discovery) else {
                return;
            };
            let effects = job.read.settled(&mut session.calls, reply);
            (effects, job.read.outcome().cloned())
        };
        let mut effects = effects;
        if let Some(outcome) = outcome {
            let mut core = self.core();
            core.jobs.histories.shift_remove(&discovery);
            match outcome {
                Ok(reply) => {
                    let ready = crate::session::discovery::HistoryReady {
                        notes: history_notes("", 0, &reply.turns),
                        turns: reply.turns,
                        omitted: reply.omitted,
                    };
                    effects.extend(core.session.history_ready(discovery, Ok(ready)));
                }
                Err(message) => effects.extend(core.session.history_ready(discovery, Err(message))),
            }
        }
        self.apply(effects);
    }

    pub(super) fn facts_settled(&self, operation: u64, call: u64, reply: Result<&Value, &str>) {
        let (effects, outcome) = {
            let mut core = self.core();
            let Core { session, jobs, .. } = &mut *core;
            let Some(job) = jobs.facts.get_mut(&operation) else {
                return;
            };
            let mut catalogs = self
                .shared
                .catalogs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let effects = job
                .read
                .settled(&mut session.calls, &mut catalogs, call, reply.ok());
            (effects, job.read.outcome().cloned())
        };
        let mut effects = effects;
        if let Some(outcome) = outcome {
            let mut core = self.core();
            core.jobs.facts.shift_remove(&operation);
            effects.extend(facts_outcome(operation, outcome));
        }
        self.apply(effects);
    }

    pub(super) fn rate_limits_settled(&self, call: u64, reply: Result<&Value, &str>) {
        let effects = {
            let mut core = self.core();
            let Some(read) = core.jobs.rate.take() else {
                return;
            };
            let closed = core.session.is_closed();
            read.settled(call, closed, reply.ok(), &core.session.frames)
        };
        self.apply(effects);
    }

    pub(super) fn launch_config(&self, operation: u64, reply: Result<&Value, &str>) {
        let effects = {
            let mut core = self.core();
            match reply.map(configured_turn_policy) {
                Ok(Ok(policy)) => {
                    core.session.permission_mode = None;
                    core.session.applied_permission_mode = None;
                    let options = with_selection(policy, &core.selection);
                    core.session.launch_ready(
                        operation,
                        Ok(Launch {
                            mode: None,
                            options,
                        }),
                    )
                }
                Ok(Err(message)) => core.session.launch_ready(operation, Err(message)),
                Err(message) => core
                    .session
                    .launch_ready(operation, Err(message.to_owned())),
            }
        };
        self.apply(effects);
    }

    /// The leader exited; the channel keeps its frames until the pipes close.
    pub(super) fn leader_exited(&self, exit: &HostExit) {
        let effects = {
            let mut core = self.core();
            core.session.lifetime.set_gone();
            if core.session.lifetime.is_exited() {
                Vec::new()
            } else {
                core.session.exited(exit)
            }
        };
        self.apply(effects);
    }

    pub(super) fn host_exited(&self, exit: &HostExit) {
        let effects = {
            let mut core = self.core();
            core.session.lifetime.set_gone();
            let mut effects = if core.session.lifetime.is_exited() {
                Vec::new()
            } else {
                core.session.exited(exit)
            };
            let frames = core.session.frames.clone();
            effects.extend(core.session.lifetime.detached(&frames, Ok(())));
            effects
        };
        self.apply(effects);
        self.finish_drained();
        self.shared.remove(self.tenant);
    }

    pub(super) fn detach_failed(&self, message: &str) {
        let effects = {
            let mut core = self.core();
            let frames = core.session.frames.clone();
            core.session
                .lifetime
                .detached(&frames, Err(message.to_owned()))
        };
        self.apply(effects);
    }

    pub fn retired(&self, result: Result<(), String>) {
        let effects = {
            let mut core = self.core();
            let frames = core.session.frames.clone();
            core.session.lifetime.retired(&frames, result)
        };
        self.apply(effects);
    }

    /// The facade's child stop could not be confirmed.
    pub fn stop_failed(&self, message: &str) {
        if let Ok(mut slot) = self.shared.stop_failure.lock() {
            *slot = Some(message.to_owned());
        }
        self.shared.host.stop_failed();
        let waiting = self
            .shared
            .retire_channel
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(channel) = waiting {
            channel.retired(Err(message.to_owned()));
        }
    }

    /// The child stop succeeded: the exit confirms the retire.
    pub fn stop_confirmed(&self) {
        if let Ok(mut slot) = self.shared.stop_failure.lock() {
            *slot = None;
        }
    }

    pub fn timer(&self, key: &str, now: f64) {
        self.set_now(now);
        if key.starts_with("request:")
            || key == crate::session::host::IDLE_TIMER
            || key == crate::session::host::DRAIN_TIMER
        {
            self.shared.host.timer(key);
            return;
        }
        if key.starts_with("tool-facts:") {
            if let Some(wake) = key
                .strip_prefix("tool-facts:")
                .and_then(|wake| wake.parse::<u64>().ok())
            {
                self.facts_deadline(wake);
            }
            return;
        }
        let effects = {
            let mut core = self.core();
            core.session.timer(key, now)
        };
        self.apply(effects);
    }

    fn facts_deadline(&self, wake: u64) {
        let (effects, outcome, operation) = {
            let mut core = self.core();
            let operation = core
                .jobs
                .facts
                .iter()
                .find(|(_, job)| job.wake == wake)
                .map(|(operation, _)| *operation);
            let Some(operation) = operation else {
                return;
            };
            let Core { session, jobs, .. } = &mut *core;
            let Some(job) = jobs.facts.get_mut(&operation) else {
                return;
            };
            let mut catalogs = self
                .shared
                .catalogs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let effects = job.read.deadline(&mut session.calls, &mut catalogs);
            (effects, job.read.outcome().cloned(), operation)
        };
        let mut effects = effects;
        if let Some(outcome) = outcome {
            let mut core = self.core();
            core.jobs.facts.shift_remove(&operation);
            effects.extend(facts_outcome(operation, outcome));
        }
        self.apply(effects);
    }

    /// The facade's one content input.
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        operation: u64,
        parts_json: &str,
        delivery: &str,
        command_id: Option<&str>,
        origin: Option<&str>,
        fence_json: Option<&str>,
        user_message_id: &str,
    ) {
        let parts = match ace_json::parse(parts_json) {
            Ok(Value::Array(parts)) => parts,
            _ => {
                self.settle_operation(
                    operation,
                    Err(crate::session::frames::Failure::failed(
                        "Codex input is not an array",
                    )),
                );
                return;
            }
        };
        let fence = fence_json.and_then(|json| ace_json::parse(json).ok());
        // No fence is no fence: a steer with one is checked against the turn it
        // named, and a provider refusal is then never retried (`session.ts`).
        let value = fence.as_ref().map(ValueFence::new);
        let delivery = if delivery == "steer" {
            Delivery::Steer
        } else {
            Delivery::Queue
        };
        let origin = match origin {
            Some("ace") => Some(InputSource::Ace),
            Some("agent") => Some(InputSource::Agent),
            _ => None,
        };
        let generated = user_message_id.to_owned();
        let user = move || generated.clone();
        let effects = {
            let mut core = self.core();
            core.session.send(SendInput {
                operation,
                parts: &parts,
                delivery,
                command_id,
                origin,
                fence: value.as_ref().map(|value| value as &dyn SteerFence),
                user_message_id: &user,
                answering: None,
            })
        };
        self.apply(effects);
    }

    pub fn interrupt(&self, operation: u64, agent: Option<&str>, cascade: bool) {
        let effects = {
            let mut core = self.core();
            core.session.interrupt(operation, agent, cascade)
        };
        self.apply(effects);
    }

    pub fn stop_task(&self, operation: u64, task: &str) {
        let effects = {
            let mut core = self.core();
            core.session.stop_task(operation, task)
        };
        self.apply(effects);
    }

    pub fn resolve(
        &self,
        operation: u64,
        key: &str,
        resolution_json: &str,
        user_message_id: &str,
        interaction_id: Option<&str>,
        model: &str,
    ) {
        let Ok(resolution) = ace_json::parse(resolution_json) else {
            self.settle_operation(
                operation,
                Err(crate::session::frames::Failure::interaction_unavailable(
                    "Codex resolution is not JSON",
                )),
            );
            return;
        };
        let generated = user_message_id.to_owned();
        let user = move || generated.clone();
        let effects = {
            let mut core = self.core();
            core.session.resolve(Answer {
                operation,
                key: key.to_owned(),
                resolution: &resolution,
                user_message_id: &user,
                interaction_id,
                model,
            })
        };
        self.apply(effects);
    }

    pub fn configure(
        &self,
        operation: u64,
        selection_json: &str,
        model: Option<&str>,
        reopen: bool,
    ) {
        let selection = match ace_json::parse(selection_json) {
            Ok(value) => match parse_selection(&value) {
                Ok(selection) => selection,
                Err(message) => {
                    self.settle_operation(
                        operation,
                        Err(crate::session::frames::Failure::failed(message)),
                    );
                    return;
                }
            },
            Err(error) => {
                self.settle_operation(
                    operation,
                    Err(crate::session::frames::Failure::failed(error.to_string())),
                );
                return;
            }
        };
        let thread = {
            let mut core = self.core();
            if let Err(message) = core.session.assert_open() {
                drop(core);
                self.settle_operation(
                    operation,
                    Err(crate::session::frames::Failure::failed(message)),
                );
                return;
            }
            if reopen {
                drop(core);
                self.settle_operation(operation, Ok(Value::from("reopen")));
                return;
            }
            let thread = core.session.root.clone();
            core.model = model.unwrap_or_default().to_owned();
            core.selection = selection.clone();
            thread
        };
        let mut params = Map::new();
        params.insert("threadId", Value::from(thread));
        params.insert(
            "model",
            model
                .map(|model| Value::from(model.to_owned()))
                .unwrap_or(Value::Null),
        );
        params.insert("effort", Value::Null);
        params.insert("summary", Value::Null);
        params.insert("serviceTier", Value::Null);
        for (key, value) in selection_options(&selection) {
            params.insert(key, value);
        }
        self.request_operation(
            operation,
            "thread/settings/update",
            Some(Value::Object(params)),
            Some(30_000.0),
        );
    }

    pub fn mcp_status(&self, operation: u64) {
        let thread = self.core().session.root.clone();
        let effects = {
            let mut core = self.core();
            core.session.mcp_status(operation, &thread)
        };
        self.apply(effects);
    }

    pub fn mcp_add(&self, operation: u64, name: &str, input_json: &str) {
        let Ok(input) = ace_json::parse(input_json) else {
            self.settle_operation(
                operation,
                Err(crate::session::frames::Failure::failed(
                    "Codex server input is not JSON",
                )),
            );
            return;
        };
        let thread = self.core().session.root.clone();
        let effects = {
            let mut core = self.core();
            core.session.mcp_add(operation, &thread, name, &input)
        };
        self.apply(effects);
    }

    pub fn mcp_replace(&self, operation: u64) {
        let effects = {
            let mut core = self.core();
            core.session.mcp_replace(operation)
        };
        self.apply(effects);
    }

    pub fn mcp_reconnect(&self, operation: u64) {
        let thread = self.core().session.root.clone();
        let effects = {
            let mut core = self.core();
            core.session.mcp_reconnect(operation, &thread)
        };
        self.apply(effects);
    }

    pub fn mcp_toggle(&self, operation: u64, name: &str, on: bool) {
        let thread = self.core().session.root.clone();
        let effects = {
            let mut core = self.core();
            core.session.mcp_toggle(operation, &thread, name, on)
        };
        self.apply(effects);
    }

    pub fn goal(&self, operation: u64, change_json: &str) {
        let Ok(change) = ace_json::parse(change_json) else {
            self.settle_operation(
                operation,
                Err(crate::session::frames::Failure::failed(
                    "Codex goal change is not JSON",
                )),
            );
            return;
        };
        let thread = {
            let core = self.core();
            if let Err(message) = core.session.assert_open() {
                drop(core);
                self.settle_operation(
                    operation,
                    Err(crate::session::frames::Failure::failed(message)),
                );
                return;
            }
            core.session.root.clone()
        };
        self.request_operation(
            operation,
            "thread/goal/set",
            Some(Value::Object(goal_params(&thread, &change))),
            Some(30_000.0),
        );
    }

    pub fn clear_goal(&self, operation: u64) {
        let thread = {
            let core = self.core();
            if let Err(message) = core.session.assert_open() {
                drop(core);
                self.settle_operation(
                    operation,
                    Err(crate::session::frames::Failure::failed(message)),
                );
                return;
            }
            core.session.root.clone()
        };
        let mut params = Map::new();
        params.insert("threadId", Value::from(thread));
        params.insert("origin", Value::from("user"));
        self.request_operation(
            operation,
            "thread/goal/clear",
            Some(Value::Object(params)),
            Some(30_000.0),
        );
    }

    /// One facade request through the host; the operation settles with its reply.
    pub fn request_operation(
        &self,
        operation: u64,
        method: &str,
        params: Option<Value>,
        timeout_ms: Option<f64>,
    ) {
        let call = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut owners) = self.shared.owners.lock() {
            owners.insert(
                call,
                Owner::Js {
                    tenant: self.tenant,
                    operation,
                },
            );
        }
        let timeout = match timeout_ms {
            Some(ms) => Timeout::After(ms),
            None => Timeout::Disabled,
        };
        if let Err(error) =
            self.shared
                .host
                .request(self.tenant, method, params.as_ref(), call, timeout)
        {
            if let Ok(mut owners) = self.shared.owners.lock() {
                owners.shift_remove(&call);
            }
            self.settle_operation(
                operation,
                Err(crate::session::frames::Failure::failed(error.to_string())),
            );
        }
    }

    pub fn tool_facts(&self, operation: u64, model: Option<&str>) {
        let wake = self.shared.next_wake.fetch_add(1, Ordering::Relaxed);
        let effects = {
            let mut core = self.core();
            let mut catalogs = self
                .shared
                .catalogs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let (read, effects) = ToolFactsRead::start(
                &self.cwd,
                model,
                &mut catalogs,
                &mut core.session.calls,
                wake,
            );
            core.jobs.facts.insert(operation, FactsJob { read, wake });
            effects
        };
        self.apply(effects);
    }

    /// The resumed thread's history, awaited by the open before its first turn.
    pub fn read_root(&self, operation: u64) {
        let thread = self.core().session.root.clone();
        if thread.is_empty() {
            self.settle_operation(operation, Ok(Value::Null));
            return;
        }
        let effects = {
            let mut core = self.core();
            core.read_operations.push(operation);
            core.session.read_root(&thread)
        };
        self.apply(effects);
    }

    /// Every read that finished settles its open: the root is no longer being
    /// read, or it never started because a read already held it.
    fn settle_finished_reads_into(&self, events: &mut Vec<SessionEvent>) {
        loop {
            let waiting = {
                let mut core = self.core();
                if core.read_operations.is_empty() {
                    break;
                }
                let reading = !core.session.root.is_empty()
                    && core
                        .session
                        .discovery
                        .reads
                        .contains_key(&core.session.root);
                if reading {
                    break;
                }
                std::mem::take(&mut core.read_operations)
            };
            for operation in waiting {
                self.settle_operation_into(operation, Ok(Value::Null), events);
            }
        }
    }

    pub fn rate_limits(&self) {
        let (effects, _call) = {
            let mut core = self.core();
            let (read, effects) = RateLimitsRead::start(&mut core.session.calls);
            core.jobs.rate = Some(read);
            (effects, 0u64)
        };
        self.apply(effects);
    }

    pub fn catalog_start(&self) {
        let effects = {
            let mut core = self.core();
            core.session.catalog_start()
        };
        self.apply(effects);
    }

    pub fn close(&self, operation: u64, reason: &str) {
        let retirement = match reason {
            "idle" => Retirement::Idle,
            "user" => Retirement::User,
            _ => Retirement::Shutdown,
        };
        let effects = {
            let mut core = self.core();
            core.close_operation = Some(operation);
            let busy = core.session.busy();
            core.session.lifetime.close(retirement, busy)
        };
        self.apply(effects);
    }

    pub fn fail_open(&self, operation: u64) {
        let effects = {
            let mut core = self.core();
            core.close_operation = Some(operation);
            let busy = core.session.busy();
            core.session.lifetime.fail_open(busy)
        };
        self.apply(effects);
    }

    pub fn abort(&self, reason: &str) {
        let effects = {
            let mut core = self.core();
            let busy = core.session.busy();
            let frames = core.session.frames.clone();
            core.session
                .lifetime
                .abort(&frames, reason.to_owned(), busy)
        };
        self.apply(effects);
    }
}

/// The facade's fence, as two values read in the same synchronous step.
struct ValueFence {
    turn: Option<String>,
    current: bool,
}

impl ValueFence {
    fn new(value: &Value) -> ValueFence {
        let map = value.as_object().cloned().unwrap_or_default();
        ValueFence {
            turn: map.get("turn").and_then(Value::as_str).map(str::to_owned),
            current: map.get("current").and_then(Value::as_bool) != Some(false),
        }
    }
}

impl SteerFence for ValueFence {
    fn turn(&self) -> Option<&str> {
        self.turn.as_deref()
    }

    fn current(&self) -> bool {
        self.current
    }
}

/// `getLaunchOptions`' options: the policy plus the selected effort and tier.
fn with_selection(policy: Map, selection: &Selection) -> Map {
    let mut options = policy;
    for (key, value) in selection_options(selection) {
        options.insert(key, value);
    }
    options
}

/// `CodexToolFacts` as the facade's `codexToolListing` reads it: absent facts
/// are absent, never `null` (the TypeScript keys on `undefined`).
fn facts_json(facts: &CodexToolFacts) -> Value {
    let mut map = Map::new();
    if let Some(model) = &facts.model {
        map.insert("model", Value::from(model.clone()));
    }
    if let Some(provider) = &facts.provider {
        map.insert("provider", Value::from(provider.clone()));
    }
    if let Some(source) = facts.catalog_source {
        map.insert("catalogSource", Value::from(source.as_str()));
    }
    if let Some(catalog) = &facts.catalog {
        map.insert(
            "catalog",
            Value::Array(
                catalog
                    .iter()
                    .map(|slug| Value::from(slug.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(features) = &facts.features {
        map.insert("features", features.clone());
    }
    Value::Object(map)
}

fn facts_outcome(operation: u64, outcome: ToolFactsOutcome) -> Vec<Effect> {
    match outcome {
        ToolFactsOutcome::Aborted => vec![Effect::Settle {
            id: operation,
            result: Err(crate::session::frames::Failure::failed(
                "Codex tool facts aborted",
            )),
        }],
        ToolFactsOutcome::Facts(facts) => vec![Effect::Settle {
            id: operation,
            result: Ok(facts_json(&facts)),
        }],
    }
}

fn goal_params(thread: &str, change: &Value) -> Map {
    let mut params = Map::new();
    params.insert("threadId", Value::from(thread.to_owned()));
    params.insert("origin", Value::from("user"));
    let change = change.as_object().cloned().unwrap_or_default();
    if let Some(objective) = change.get("objective") {
        params.insert("objective", objective.clone());
        params.insert("status", Value::from("active"));
    } else if let Some(status) = change.get("status") {
        params.insert("status", status.clone());
    }
    params
}

#[cfg(test)]
mod tests;
