// SPDX-License-Identifier: Apache-2.0
//! The actor binding (E5.2 steps 13 to 16): the frame entry, the flow reads, the facade's actor
//! members, the shell's frame promises, and the shell's live buffer. Behaviour lives in
//! `ace_engine::actor` and `ace_engine::frames`; this file only translates values and errors.

use ace_engine::actor::intake::{self, FrameInput, Measure};
use ace_engine::actor::state::{FrameRef, session_instance};
use ace_engine::executor::Lane;
use ace_engine::frames::live::LiveStore;
use ace_engine::ports::Ports;
use napi::Env;
use napi::bindgen_prelude::{FnArgs, FunctionRef, JsObjectValue, Object};
use napi_derive::napi;
use std::rc::Rc;

pub use super::runtime::{ActorRuntime, LiveHooks};
use super::{NativeEngine, engine_error};

/// What the actor needs from the shell, shared by every actor of one engine.
#[napi]
impl NativeEngine {
    /// `liveThreadIds()` (`index.ts:1049`).
    #[napi]
    pub fn live_thread_ids(&self) -> Vec<String> {
        self.engine
            .core()
            .with_state(|state| ace_engine::actor::live_thread_ids(state))
            .unwrap_or_default()
    }

    /// `workload()` (`index.ts:795`). `queuedSends` is E5.4's read.
    #[napi]
    pub fn workload(&self) -> napi::Result<String> {
        let core = self.engine.core();
        let deps = core.actor_deps.borrow().clone();
        let (sessions, frames, bytes) = core
            .with_state(|state| {
                let mut sessions = 0;
                let mut frames = 0;
                let mut bytes = 0;
                for actor in state.actors.live() {
                    if actor.session_attached {
                        sessions += 1;
                    }
                    let (actor_frames, actor_bytes) = actor.backlog();
                    frames += actor_frames;
                    bytes += actor_bytes;
                }
                (sessions, frames, bytes)
            })
            .map_err(engine_error)?;
        let mut sends = 0;
        for thread in self.live_thread_ids() {
            sends += deps
                .repo
                .queued_count(core, &thread)
                .map_err(engine_error)?;
        }
        Ok(format!(
            "{{\"activeSessions\":{sessions},\"engine.frames\":{frames},\"engine.frameBytes\":{bytes},\"engine.queuedSends\":{sends}}}"
        ))
    }

    /// `rootAgent(threadId)` (`index.ts:853`).
    #[napi]
    pub fn root_agent(&self, env: Env, thread_id: String) -> napi::Result<Option<String>> {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let deps = core.actor_deps.borrow().clone();
        if deps
            .repo
            .root_agent_id(core, &thread_id)
            .map_err(engine_error)?
            .is_some()
        {
            return deps
                .repo
                .root_agent_id(core, &thread_id)
                .map_err(engine_error);
        }
        ace_engine::actor::get_or_create(core, &thread_id).map_err(engine_error)?;
        let now = core.ports.now();
        let generation = core
            .with_state(|state| state.actors.get(&thread_id).map(|actor| actor.generation))
            .map_err(engine_error)?
            .unwrap_or(0);
        deps.repo
            .apply(
                core,
                &thread_id,
                &[ace_json::json!({"type": "tick"})],
                now,
                generation,
            )
            .map_err(engine_error)?;
        deps.repo
            .root_agent_id(core, &thread_id)
            .map_err(engine_error)
    }

    /// A JavaScript session's frame (`actor.ts:303`): `done`, `batch`, `flush` or `rejected:…`.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn actor_frame(
        &self,
        env: Env,
        thread_id: String,
        instance: String,
        generation: f64,
        handle: f64,
        frame: Object,
        is_object: bool,
        branded: bool,
        certified: bool,
        bytes: Option<f64>,
        measure_error: Option<String>,
    ) -> napi::Result<String> {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let Some(actor) = instance
            .parse()
            .ok()
            .and_then(|id| session_instance(core, &thread_id, id))
        else {
            return Ok("done".to_string());
        };
        let envelope = super::frames::read_envelope(&frame, is_object, branded)?;
        let channel_sdk = super::frames::string_property(&frame, "channel")
            .is_some_and(|channel| channel == "sdk");
        let measure = if certified {
            // Only the shell's certificate admits the count without a bounded re-measure.
            Measure::Certified {
                bytes: bytes.unwrap_or(0.0) as usize,
            }
        } else {
            match measure_error {
                Some(message) => Measure::Bounded(Err(message)),
                None => Measure::Bounded(Ok(bytes.unwrap_or(0.0) as usize)),
            }
        };
        let ack = intake::frame(
            core,
            &actor,
            generation as u64,
            FrameInput {
                frame: FrameRef::Js {
                    handle: handle as u32,
                    sdk: channel_sdk,
                },
                envelope,
                channel_sdk,
                measure,
                native_ack: None,
            },
        );
        Ok(match ack {
            intake::Ack::Done => "done".to_string(),
            intake::Ack::Rejected(message) => format!("rejected:{message}"),
            intake::Ack::Batch(call) => match call {
                Some(call) => format!("batch:{call}"),
                None => "batch".to_string(),
            },
            intake::Ack::AfterFlush(receiver) => {
                // The frame is refused visibly; its promise settles when the flush does.
                let call = core.actor_deps.borrow().clone().acks.alloc();
                if let Some(call) = call {
                    let ports = Rc::clone(&self.ports);
                    let core = Rc::clone(core);
                    let task = core.executor.spawn(Lane::Work, async move {
                        let _ = receiver.await;
                        ports.settle_call(call, None);
                    });
                    task.detach();
                    format!("flush:{call}")
                } else {
                    "flush".to_string()
                }
            }
        })
    }

    /// `outputFlow.paused` (`actor.ts:85`).
    #[napi]
    pub fn actor_paused(&self, env: Env, thread_id: String, instance: String) -> bool {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let actor = instance
            .parse()
            .ok()
            .and_then(|id| session_instance(core, &thread_id, id));
        ace_engine::actor::flow::paused(core, actor.as_ref())
    }

    /// `outputFlow.wait` (`actor.ts:87`).
    #[napi]
    pub fn actor_wait(&self, env: Env, thread_id: String, instance: String, call: f64) {
        let _guard = self.ports.enter(env);
        let ports = Rc::clone(&self.ports);
        let inner = Rc::clone(self.engine.core());
        let executor = Rc::clone(&inner);
        let actor = instance
            .parse()
            .ok()
            .and_then(|id| session_instance(&inner, &thread_id, id));
        let task = inner.executor.spawn(Lane::Work, async move {
            ace_engine::actor::flow::wait(executor, actor).await;
            ports.settle_call(call as u64, None);
        });
        task.detach();
    }

    /// The store's live-write quarantine (`index.ts:367`–`:369`): fail the thread's actor.
    #[napi]
    pub fn actor_quarantine(&self, env: Env, thread_id: String, message: String) {
        let _guard = self.ports.enter(env);
        ace_engine::actor::failure::quarantine(self.engine.core(), &thread_id, &message);
    }

    /// A buffered engine write's snapshot, inside the flush's transaction (E5.2 step 16).
    #[napi]
    pub fn persist_live(&self, token: f64) -> napi::Result<()> {
        let snapshot = self.actor.snapshots.borrow().get(&(token as u64)).cloned();
        match snapshot {
            Some(snapshot) => snapshot.persist().map_err(engine_error),
            None => Ok(()),
        }
    }

    /// A live write was replaced or dropped without storing it: release its snapshot's token.
    #[napi]
    pub fn discard_live(&self, token: f64) {
        self.actor.snapshots.borrow_mut().remove(&(token as u64));
    }

    /// After the outermost commit, before the buffer retires the batch: the batch is durable.
    #[napi]
    pub fn committed_live(&self, token: f64) {
        let snapshot = self.actor.snapshots.borrow_mut().remove(&(token as u64));
        if let Some(snapshot) = snapshot {
            snapshot.committed();
        }
    }

    /// The shell's deadline and retry timer: queue one live-buffer flush on the pump
    /// (E5.2 step 16). Synchronous; the task runs from a later pump, outside any transaction.
    #[napi]
    pub fn actor_flush_due(&self, env: Env) {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let live = Rc::clone(&self.actor.live) as Rc<dyn LiveStore>;
        ace_engine::frames::live::flush_due(core, &live);
    }

    /// The shell's live-buffer hooks, installed once by `liveStorePort`.
    #[napi]
    pub fn attach_live_store(&self, hooks: Object) -> napi::Result<()> {
        let read = |name: &str| -> napi::Result<napi::bindgen_prelude::FunctionRef<(), ()>> {
            hooks
                .get_named_property::<napi::bindgen_prelude::FunctionRef<(), ()>>(name)
                .map_err(|_| napi::Error::from_reason(format!("live hook {name} is missing")))
        };
        let installed = LiveHooks {
            writable_now: hooks
                .get_named_property("writableNow")
                .map_err(|_| napi::Error::from_reason("writableNow is missing"))?,
            writable: hooks
                .get_named_property("writable")
                .map_err(|_| napi::Error::from_reason("writable is missing"))?,
            history_writing: hooks
                .get_named_property("historyWriting")
                .map_err(|_| napi::Error::from_reason("historyWriting is missing"))?,
            live_write_blocked: hooks
                .get_named_property("liveWriteBlocked")
                .map_err(|_| napi::Error::from_reason("liveWriteBlocked is missing"))?,
            prepare_live_write: hooks
                .get_named_property("prepareLiveWrite")
                .map_err(|_| napi::Error::from_reason("prepareLiveWrite is missing"))?,
            buffer_live_write: hooks
                .get_named_property("bufferLiveWrite")
                .map_err(|_| napi::Error::from_reason("bufferLiveWrite is missing"))?,
            run_scheduled: hooks
                .get_named_property("runScheduled")
                .map_err(|_| napi::Error::from_reason("runScheduled is missing"))?,
            flush_live_writes: hooks
                .get_named_property("flushLiveWrites")
                .map_err(|_| napi::Error::from_reason("flushLiveWrites is missing"))?,
            is_store_retry: hooks
                .get_named_property("isStoreRetry")
                .map_err(|_| napi::Error::from_reason("isStoreRetry is missing"))?,
        };
        let _ = read;
        *self.live_hooks.borrow_mut() = Some(installed);
        Ok(())
    }

    /// `actorContext` installs the batch helper once.
    #[napi]
    pub fn attach_translator_helper(&self, helper: FunctionRef<FnArgs<(String, String)>, String>) {
        *self.actor.helper.borrow_mut() = Some(Rc::new(helper));
    }

    /// The actor's dependencies as the probe replaces them (E5.2 step 15).
    pub fn actor_runtime(&self) -> &Rc<ActorRuntime> {
        &self.actor
    }
}
