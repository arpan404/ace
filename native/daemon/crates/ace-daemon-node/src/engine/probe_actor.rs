// SPDX-License-Identifier: Apache-2.0
//! The probe's actor (E5.2 step 15), compiled only with the `engine-probe` cargo feature. It is a
//! scripted repository and link set, plus E5.2's real `LiveStore`: no fold and no thread
//! behaviour, so the seam tests prove the mailbox, the acknowledgement and the rollback rules
//! before E5.3.

use ace_engine::actor::deps::{
    ActorDeps, ActorLinks, ActorRepo, ActorTranslator, Route, ScheduleView,
};
use ace_engine::frames::live::LiveSnapshot;
use ace_engine::{Core, EngineError, ThreadId};
use ace_json::Value;
use napi_derive::napi;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use super::js_translator::JsTranslator;
use super::{NativeEngine, engine_error};

/// What one `apply` did.
#[derive(Default)]
pub struct Applied {
    pub facts: usize,
    pub outermost: bool,
    pub committed: bool,
    pub streamed: bool,
    pub generation: u64,
    pub frames: usize,
}

/// The probe's shared script: the answers its repository gives and what it saw.
pub struct ProbeLog {
    pub delta_stream: bool,
    pub status: RefCell<Value>,
    pub aborted: RefCell<u32>,
    pub wakes: RefCell<u32>,
    pub diagnostics: RefCell<Vec<Value>>,
    pub released: RefCell<u32>,
    pub expired: RefCell<Vec<u64>>,
    pub retired: RefCell<Vec<u64>>,
    pub applied: RefCell<Vec<Applied>>,
    pub snapshots: RefCell<Vec<&'static str>>,
    pub live: RefCell<Vec<Value>>,
}

impl Default for ProbeLog {
    fn default() -> Self {
        ProbeLog {
            delta_stream: false,
            status: RefCell::new(ace_json::json!({"state": "running"})),
            aborted: RefCell::new(0),
            wakes: RefCell::new(0),
            diagnostics: RefCell::new(Vec::new()),
            released: RefCell::new(0),
            expired: RefCell::new(Vec::new()),
            retired: RefCell::new(Vec::new()),
            applied: RefCell::new(Vec::new()),
            snapshots: RefCell::new(Vec::new()),
            live: RefCell::new(Vec::new()),
        }
    }
}

impl ProbeLog {
    fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
        match value {
            Value::Object(map) => match map.get(name) {
                Some(Value::String(text)) => Some(text.as_str()),
                _ => None,
            },
            _ => None,
        }
    }

    /// The probe's transcript of what it saw, as JSON.
    pub fn json(&self) -> String {
        let applied: Vec<Value> = self
            .applied
            .borrow()
            .iter()
            .map(|entry| {
                ace_json::json!({
                    "facts": entry.facts as u64,
                    "frames": entry.frames as u64,
                    "outermost": entry.outermost,
                    "committed": entry.committed,
                    "streamed": entry.streamed,
                    "generation": entry.generation,
                })
            })
            .collect();
        let expired: Vec<Value> = self
            .expired
            .borrow()
            .iter()
            .map(|generation| Value::Number((*generation).into()))
            .collect();
        ace_json::to_string(&ace_json::json!({
            "aborted": f64::from(*self.aborted.borrow()) as u64,
            "wakes": f64::from(*self.wakes.borrow()) as u64,
            "released": f64::from(*self.released.borrow()) as u64,
            "diagnostics": Value::Array(self.diagnostics.borrow().clone().into()),
            "applied": Value::Array(applied.into()),
            "expired": Value::Array(expired.into()),
            "retired": Value::Array(self.retired.borrow().iter().map(|g| Value::Number((*g).into())).collect::<Vec<Value>>().into()),
            "snapshots": Value::Array(self.snapshots.borrow().iter().map(|name| Value::String((*name).into())).collect::<Vec<Value>>().into()),
            "live": Value::Array(self.live.borrow().clone().into()),
        }))
    }
}

/// The probe's repository: fixed answers, one recorded event per `apply`.
struct ProbeRepo {
    log: Rc<ProbeLog>,
    deps: RefCell<Rc<ActorDeps>>,
}

impl ActorRepo for ProbeRepo {
    fn status(&self, _core: &Core, _thread: &ThreadId) -> Result<Value, EngineError> {
        Ok(self.log.status.borrow().clone())
    }
    fn route(&self, _core: &Core, _thread: &ThreadId) -> Result<Route, EngineError> {
        Ok(Route {
            provider: "probe".to_string(),
            backend: None,
        })
    }
    fn quiescent(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(true)
    }
    fn running_foreground_command(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn stream(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        _now: f64,
    ) -> Result<bool, EngineError> {
        if !self.log.delta_stream {
            return Ok(false);
        }
        let deltas = facts
            .iter()
            .all(|fact| matches!(ProbeLog::text(fact, "type"), Some("item.delta" | "signal")));
        if !deltas {
            return Ok(false);
        }
        let deps = self.deps.borrow().clone();
        deps.live.prepare_live_write(1.0)?;
        let snapshot = Rc::new(ProbeSnapshot {
            log: Rc::clone(&self.log),
        });
        let event = ace_json::json!({"type": "probe.live", "facts": facts.len() as u64});
        self.log.live.borrow_mut().push(event.clone());
        deps.live
            .buffer_live_write(thread, &[event], 0.0, snapshot)?;
        let _ = core;
        Ok(true)
    }
    fn apply(
        &self,
        core: &Core,
        _thread: &ThreadId,
        facts: &[Value],
        _now: f64,
        generation: u64,
    ) -> Result<(), EngineError> {
        let mut entry = Applied {
            facts: facts.len(),
            generation,
            ..Applied::default()
        };
        // The probe owns no sequence source, so it records the batch in its log rather than
        // writing an event: E5.3's repository owns the real rows.
        core.store.atomic(|_tx| {
            entry.outermost = core.store.is_outermost();
            entry.committed = true;
            Ok(())
        })?;
        self.log.applied.borrow_mut().push(entry);
        Ok(())
    }
    fn deadline(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError> {
        // The stored deadline plus the translator's own, as the repository combines them.
        Ok(_translator.map(|deadline| deadline as f64))
    }
    fn schedule_view(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<ScheduleView>, EngineError> {
        Ok(Some(ScheduleView {
            done: false,
            left_running: false,
        }))
    }
    fn evict(&self, _core: &Core, _thread: &ThreadId) {}
    fn clear_incomplete_blobs(&self, _core: &Core, _thread: &ThreadId) {}
    fn root_agent_id(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Ok(Some("root".to_string()))
    }
    fn engine_queue_fact(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError> {
        Ok(None)
    }
    fn queue_paused(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn queued_count(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Ok(0)
    }
    fn latest_generation(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Ok(0)
    }
    fn mark_yielded_end(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        facts: Vec<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        Ok(facts)
    }
    fn session_instance(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Ok(Some("probe".to_string()))
    }
    fn reserved_slot(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn retiring_count(&self, _core: &Core) -> Result<usize, EngineError> {
        Ok(0)
    }
    fn released_thread(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn attachment(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _hash: &str,
    ) -> Result<Option<Value>, EngineError> {
        Ok(None)
    }
    fn cursor_record(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _entries: &[Value],
    ) -> Result<(), EngineError> {
        Ok(())
    }
}

/// One probe live write's snapshot: it records the order, nothing else.
struct ProbeSnapshot {
    log: Rc<ProbeLog>,
}

impl LiveSnapshot for ProbeSnapshot {
    fn persist(&self) {
        self.log.snapshots.borrow_mut().push("persist");
    }
    fn committed(&self) {
        self.log.snapshots.borrow_mut().push("committed");
    }
}

/// The probe's links: every call recorded, nothing caused.
struct ProbeLinks {
    log: Rc<ProbeLog>,
}

impl ActorLinks for ProbeLinks {
    fn wake(&self, _core: &Core, _thread: &ThreadId) {
        *self.log.wakes.borrow_mut() += 1;
    }
    fn abort_session(&self, _core: &Core, _thread: &ThreadId, _drop_session: bool) {
        *self.log.aborted.borrow_mut() += 1;
    }
    fn expire(&self, _core: &Core, _thread: &ThreadId, generation: u64) {
        self.log.expired.borrow_mut().push(generation);
    }
    fn diagnostic(&self, _core: &Core, _thread: &ThreadId, raw: &[Value]) {
        self.log.diagnostics.borrow_mut().extend_from_slice(raw);
    }
    fn release_leases(&self, _core: &Core, _tokens: &[u64]) {
        *self.log.released.borrow_mut() += 1;
    }
}

/// The probe's per-thread logs.
#[derive(Default)]
pub struct ProbeThreads {
    pub logs: HashMap<String, Rc<ProbeLog>>,
}

#[napi]
impl NativeEngine {
    /// `attachSession(threadId, spec)`: installs the probe's dependencies and starts its actor.
    #[napi]
    pub fn probe_attach_session(
        &self,
        env: napi::Env,
        thread_id: String,
        stream: Option<String>,
        generation: Option<f64>,
    ) -> napi::Result<()> {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let log = Rc::new(ProbeLog {
            delta_stream: stream.as_deref() == Some("deltas"),
            ..ProbeLog::default()
        });
        let live = Rc::clone(&self.actor.live) as Rc<dyn ace_engine::frames::live::LiveStore>;
        let repo = Rc::new(ProbeRepo {
            log: Rc::clone(&log),
            deps: RefCell::new(Rc::clone(&self.actor.deps)),
        }) as Rc<dyn ActorRepo>;
        let links = Rc::new(ProbeLinks {
            log: Rc::clone(&log),
        }) as Rc<dyn ActorLinks>;
        let deps = Rc::new(ActorDeps::new(
            repo,
            links,
            live,
            Rc::clone(&self.actor.acks) as Rc<dyn ace_engine::actor::deps::FrameAcks>,
            self.actor.deps.idle_ms,
        ));
        if let Some(helper) = self.actor.helper.borrow().clone() {
            deps.translators.borrow_mut().insert(
                thread_id.clone(),
                (
                    generation.map(|value| value as u64).unwrap_or(0),
                    ActorTranslator::Js(Box::new(JsTranslator {
                        thread: thread_id.clone(),
                        helper,
                        ports: Rc::clone(&self.ports),
                    })),
                ),
            );
        }
        self.actor.install_deps(core, Rc::clone(&deps));
        *self.actor.probe.borrow_mut() = Some(Rc::clone(&log));
        self.probe_threads
            .borrow_mut()
            .logs
            .insert(thread_id.clone(), Rc::clone(&log));
        ace_engine::actor::get_or_create(core, &thread_id).map_err(engine_error)?;
        core.with_state(|state| {
            if let Some(actor) = state.actors.by_thread.get_mut(&thread_id) {
                actor.session_attached = true;
                if let Some(generation) = generation {
                    actor.generation = generation as u64;
                }
            }
        })
        .map_err(engine_error)?;
        Ok(())
    }

    /// The probe's transcript: aborts, wakes, applies, snapshots and diagnostics, as JSON.
    #[napi]
    pub fn probe_actor_log(&self, thread_id: String) -> String {
        self.probe_threads
            .borrow()
            .logs
            .get(&thread_id)
            .map(|log| log.json())
            .unwrap_or_else(|| "{}".to_string())
    }

    /// `retire()`: what an `onExit` does to the actor's generation.
    #[napi]
    pub fn probe_retire(&self, thread_id: String) {
        let core = self.engine.core();
        let retired = core
            .with_state(|state| {
                state.actors.by_thread.get_mut(&thread_id).map(|actor| {
                    let generation = actor.retire_generation();
                    actor.generation = generation + 1;
                    generation
                })
            })
            .ok()
            .flatten();
        if let Some(generation) = retired {
            let deps = core.actor_deps.borrow().clone();
            deps.links.expire(core, &thread_id, generation);
        }
    }

    /// The probe's status counter: a test bumps it to make the status change.
    #[napi]
    pub fn probe_set_status(&self, thread_id: String, state: String) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            *log.status.borrow_mut() = ace_json::json!({"state": state});
        }
    }

    /// The probe's applied entries, as JSON.
    #[napi]
    pub fn probe_applied(&self, thread_id: String) -> String {
        match self.probe_threads.borrow().logs.get(&thread_id) {
            Some(log) => {
                let entries: Vec<Value> = log
                    .applied
                    .borrow()
                    .iter()
                    .map(|entry| {
                        ace_json::json!({
                            "facts": entry.facts as u64,
                            "frames": entry.frames as u64,
                            "outermost": entry.outermost,
                            "committed": entry.committed,
                            "generation": entry.generation,
                        })
                    })
                    .collect();
                ace_json::to_string(&Value::Array(entries.into()))
            }
            None => "[]".to_string(),
        }
    }
}
