// SPDX-License-Identifier: Apache-2.0
//! The probe's session hooks: attaching a scripted session, its transcript and its retirement.

use ace_engine::actor::deps::{ActorDeps, ActorLinks, ActorRepo, ActorTranslator};
use ace_json::Value;
use napi_derive::napi;
use std::cell::RefCell;
use std::rc::Rc;

use super::log::ProbeLog;
use super::repo::ProbeRepo;
use super::script::ProbeLinks;
use crate::engine::js_translator::JsTranslator;
use crate::engine::{NativeEngine, engine_error};

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
            connection: self.probe.borrow().connection(),
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
