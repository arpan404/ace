// SPDX-License-Identifier: Apache-2.0
//! The engine probe (E5.1 step 12), compiled only with the `engine-probe` cargo feature, which
//! release packaging never sets. It exposes the executor and store hooks the seam tests need and
//! no thread behaviour: a scripted task, a deferred wake, the claim, the turn log, the released
//! wakes, a close step that awaits a port, and the one stub that answers the recovery-candidate
//! scan with no rows until E5.3 lands.

use ace_engine::EngineError;
use ace_engine::executor::{Deferred, Lane};
use ace_engine::ports::Ports;
use napi::Env;
use napi::bindgen_prelude::FunctionRef;
use napi_derive::napi;

use super::NativeEngine;

/// The probe's own state: the marks scripted tasks record and the one JS callback an op runs.
#[derive(Default)]
pub struct ProbeState {
    marks: Vec<String>,
    callback: Option<std::rc::Rc<FunctionRef<(), ()>>>,
}

fn lane(name: &str) -> Lane {
    match name {
        "control" => Lane::Control,
        _ => Lane::Work,
    }
}

fn text(value: Option<&ace_json::Value>) -> Option<String> {
    match value {
        Some(ace_json::Value::String(text)) => Some(text.as_str().to_string()),
        _ => None,
    }
}

fn flag(value: Option<&ace_json::Value>) -> bool {
    matches!(value, Some(ace_json::Value::Bool(true)))
}

fn field<'a>(value: &'a ace_json::Value, name: &str) -> Option<&'a ace_json::Value> {
    match value {
        ace_json::Value::Object(map) => map.get(name),
        _ => None,
    }
}

#[napi]
impl NativeEngine {
    /// The probe's one stub: the recovery-candidate scan answers with no rows so `ready()`
    /// resolves before E5.3. E5.3 deletes this.
    #[napi]
    pub fn probe_empty_candidates(&self) {
        self.engine.core().probe_empty_candidates();
    }

    /// The claim's name, for the interleaving assertions.
    #[napi]
    pub fn probe_claim(&self) -> String {
        match self.engine.core().executor.claim() {
            0 => "idle".to_string(),
            1 => "scheduled".to_string(),
            2 => "running".to_string(),
            _ => "runningDirty".to_string(),
        }
    }

    /// Polls per turn, oldest first, as JSON.
    #[napi]
    pub fn probe_turns(&self) -> String {
        let turns = self.engine.turns();
        let list: Vec<ace_json::Value> = turns
            .iter()
            .map(|polls| ace_json::Value::Number((*polls as u64).into()))
            .collect();
        ace_json::to_string(&ace_json::Value::Array(list.into()))
    }

    /// Wakes released from the after-commit queue, in release order.
    #[napi]
    pub fn probe_woken(&self) -> Vec<String> {
        self.engine.core().wakes()
    }

    /// Runs one scripted task: `[{"op":"timer","ms":1},{"op":"defer","thread":"t1"},
    /// {"op":"write","events":[...],"defer":"t1","fail":false,"nested":{...}}]`.
    #[napi]
    pub fn probe_spawn(&self, env: Env, lane_name: String, script: String) -> napi::Result<()> {
        let parsed = ace_json::parse(&script)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let steps = match parsed {
            ace_json::Value::Array(items) => items.into_vec(),
            _ => return Err(napi::Error::from_reason("probe script is not an array")),
        };
        let core = std::rc::Rc::clone(self.engine.core());
        let ports = std::rc::Rc::clone(&self.ports);
        let probe = std::rc::Rc::clone(&self.probe);
        let callback = self.probe.borrow().callback.clone();
        let task_env = env;
        let inner = std::rc::Rc::clone(&core);
        let task = core.executor.spawn(lane(&lane_name), async move {
            let core = inner;
            for step in steps {
                let op = text(field(&step, "op")).unwrap_or_default();
                match op.as_str() {
                    "timer" => {
                        let ms = match field(&step, "ms") {
                            Some(ace_json::Value::Number(number)) => number.value(),
                            _ => 0.0,
                        };
                        let timer = ports.set_timer(ms);
                        let _ = timer.fired.await;
                    }
                    "defer" => {
                        let thread = text(field(&step, "thread")).unwrap_or_default();
                        core.defer(Deferred::Wake(thread, lane(&lane_name)));
                    }
                    "write" => probe_write(&core, &step),
                    "mark" => {
                        let label = text(field(&step, "label")).unwrap_or_default();
                        probe.borrow_mut().marks.push(label);
                    }
                    "js" => {
                        if let Some(callback) = callback.as_ref() {
                            if let Ok(function) = callback.borrow_back(&task_env) {
                                let _ = function.call(());
                            }
                        }
                    }
                    "flush" => {
                        let exclude = core.executor.current();
                        if let Err(error) = core.flush_to_quiescence(exclude).await {
                            ports.report(error.to_string());
                        }
                    }
                    other => ports.report(format!("probe: unknown step {other}")),
                }
            }
        });
        task.detach();
        Ok(())
    }

    /// Defers one wake outside a transaction: it is released at once.
    #[napi]
    pub fn probe_defer(&self, thread: String) {
        self.engine.core().defer(Deferred::Wake(thread, Lane::Work));
    }

    /// A close step that awaits a port: the Rust side arms a promise and returns its id, the
    /// shell settles it through `settlePromise(id, ok)`.
    #[napi]
    pub fn probe_stall_close_step(&self, env: Env) -> f64 {
        let _guard = self.ports.enter(env);
        let (id, receiver) = self.ports.arm_promise(Some(
            "Engine close passed its 4.5 s deadline during probe close".to_string(),
        ));
        let core = std::rc::Rc::clone(self.engine.core());
        core.set_close_stall(Box::pin(async move {
            let _ = receiver.await;
        }));
        id as f64
    }

    /// A worker task awaiting a port that may never settle: the close reports the worker, the
    /// thread and the port once.
    #[napi]
    pub fn probe_stall_worker(
        &self,
        env: Env,
        thread: String,
        worker: String,
        port: String,
    ) -> f64 {
        let _guard = self.ports.enter(env);
        let message = format!("Engine closed while {worker} for {thread} waited on {port}");
        let (id, receiver) = self.ports.arm_promise(Some(message));
        let core = std::rc::Rc::clone(self.engine.core());
        let task = core.executor.spawn(Lane::Control, async move {
            let _ = receiver.await;
        });
        task.detach();
        id as f64
    }

    /// Registers the one JS callback a `js` step runs (the seam's nesting-direction probe).
    #[napi]
    pub fn probe_set_callback(&self, callback: FunctionRef<(), ()>) {
        self.probe.borrow_mut().callback = Some(std::rc::Rc::new(callback));
    }

    /// Timers the binding still has armed; close must leave none.
    #[napi]
    pub fn probe_timer_count(&self) -> u32 {
        self.ports.timer_count() as u32
    }

    /// The transaction shell's bookkeeping: open frames, top aliases and released lists. A
    /// savepoint or rollback that outlives its finish is a leak the seam can see.
    #[napi]
    pub fn probe_stack_entries(&self) -> String {
        let (frames, released) = self.stack.borrow().entry_counts();
        format!("{{\"frames\":{frames},\"released\":{released}}}")
    }

    /// The labels scripted tasks marked, in order.
    #[napi]
    pub fn probe_marks(&self) -> Vec<String> {
        self.probe.borrow().marks.clone()
    }

    /// `attachSession` is E5.2's: a rejected promise, never a synchronous throw.
    #[napi]
    pub fn probe_attach_session(&self) -> napi::Result<()> {
        Err(engine_error(EngineError::not_ported(
            "attachSession",
            "E5.2",
        )))
    }

    /// The executor's counters, for the seam's busy-loop checks.
    #[napi]
    pub fn probe_stats(&self) -> String {
        let stats = self.engine.stats();
        format!(
            "{{\"turns\":{},\"polls\":{},\"longestPollUs\":{},\"slowPolls\":{},\"lastTurnPolls\":{}}}",
            stats.turns,
            stats.polls,
            stats.longest_poll_us,
            stats.slow_polls,
            stats.last_turn_polls
        )
    }
}

/// One `write` step: a Rust transaction with events and a deferred wake, optionally nested.
fn probe_write(core: &std::rc::Rc<ace_engine::Core>, step: &ace_json::Value) {
    let defer = text(field(step, "defer"));
    let fail = flag(field(step, "fail"));
    let events = field(step, "events")
        .cloned()
        .unwrap_or(ace_json::Value::Null);
    let json = ace_json::to_string(&events);
    let nested = field(step, "nested").cloned();
    let result = core.store.atomic(|tx| {
        if let Some(thread) = defer.clone() {
            core.defer(Deferred::Wake(thread, Lane::Work));
        }
        tx.append_events(&json)?;
        if let Some(nested) = nested.as_ref() {
            let inner_json = ace_json::to_string(
                &field(nested, "events")
                    .cloned()
                    .unwrap_or(ace_json::Value::Null),
            );
            let inner_defer = text(field(nested, "defer"));
            core.store.atomic(|tx| {
                if let Some(thread) = inner_defer.clone() {
                    core.defer(Deferred::Wake(thread, Lane::Work));
                }
                tx.append_events(&inner_json)
            })?;
        }
        if fail {
            return Err(EngineError::not_ported("a failed probe write", "E5.1"));
        }
        Ok(())
    });
    if let Err(error) = result {
        core.ports.report(error.to_string());
    }
}

fn engine_error(error: EngineError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
