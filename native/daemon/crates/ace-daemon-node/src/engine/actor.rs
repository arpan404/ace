// SPDX-License-Identifier: Apache-2.0
//! The actor binding (E5.2 steps 13 to 16): the frame entry, the flow reads, the facade's actor
//! members, the shell's frame promises, and the shell's live buffer. Behaviour lives in
//! `ace_engine::actor` and `ace_engine::frames`; this file only translates values and errors.

use ace_engine::actor::deps::{ActorDeps, FrameAcks, Unported};
use ace_engine::actor::flow::NativeFlow;
use ace_engine::actor::intake::{self, FrameInput, Measure};
use ace_engine::actor::state::FrameRef;
use ace_engine::executor::Lane;
use ace_engine::frames::live::{LiveSnapshot, LiveStore};
use ace_engine::futures::future::LocalBoxFuture;
use ace_engine::ports::{PortError, Ports};
use ace_engine::{Core, EngineError};
use ace_json::Value;
use napi::Env;
use napi::bindgen_prelude::{FnArgs, FunctionRef, JsObjectValue, Object};
use napi_derive::napi;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use super::js_translator::Helper;
use super::ports::JsPorts;
use super::{NativeEngine, engine_error};

/// What the actor needs from the shell, shared by every actor of one engine.
pub struct ActorRuntime {
    pub deps: Rc<ActorDeps>,
    pub live: Rc<JsLiveStore>,
    pub acks: Rc<JsAcks>,
    /// The shell's batch helper, installed by `actorContext`.
    pub helper: RefCell<Option<Rc<Helper>>>,
    /// Each native session's flow mirror.
    pub flows: RefCell<HashMap<String, NativeFlow>>,
    /// The probe's log, when `attachSession` installed the probe's dependencies.
    #[cfg(feature = "engine-probe")]
    pub probe: RefCell<Option<Rc<super::probe_actor::ProbeLog>>>,
}

impl ActorRuntime {
    /// `attachSession` installs the probe's dependencies over the production set.
    pub fn install_deps(&self, core: &Core, deps: Rc<ActorDeps>) {
        *core.actor_deps.borrow_mut() = deps;
    }
}

/// The shell's frame promises: one per batch, settled by its call id.
pub struct JsAcks {
    ports: Rc<JsPorts>,
}

impl FrameAcks for JsAcks {
    fn settle(&self, call: u64, reject: Option<String>) {
        self.ports.settle_call(call, reject);
    }
}

/// The shell's live-buffer entry points (step 16).
pub struct LiveHooks {
    pub writable_now: FunctionRef<(), bool>,
    pub writable: FunctionRef<f64, ()>,
    pub history_writing: FunctionRef<(), bool>,
    pub live_write_blocked: FunctionRef<(), bool>,
    pub prepare_live_write: FunctionRef<f64, Option<String>>,
    pub buffer_live_write: FunctionRef<String, Option<String>>,
    pub flush_due: FunctionRef<(), ()>,
    pub flush_live_writes: FunctionRef<(), ()>,
    pub is_store_retry: FunctionRef<String, bool>,
}

/// `LiveStore` over the shell's public store methods.
pub struct JsLiveStore {
    ports: Rc<JsPorts>,
    hooks: Rc<RefCell<Option<LiveHooks>>>,
}

impl JsLiveStore {
    fn with<R>(&self, run: impl FnOnce(&LiveHooks) -> R) -> Option<R> {
        self.hooks.borrow().as_ref().map(run)
    }
}

impl LiveStore for JsLiveStore {
    fn writable_now(&self) -> bool {
        self.with(|hooks| self.ports.call_port(&hooks.writable_now, ()))
            .and_then(Result::ok)
            .unwrap_or(false)
    }

    fn writable(&self) -> LocalBoxFuture<'static, ()> {
        let ports = Rc::clone(&self.ports);
        let hooks = Rc::clone(&self.hooks);
        let (id, receiver) = ports.arm_promise(None);
        let called = match hooks.borrow().as_ref() {
            Some(hook) => ports.call_port(&hook.writable, id as f64).is_ok(),
            None => false,
        };
        if !called {
            return Box::pin(async {});
        }
        Box::pin(async move {
            let _ = receiver.await;
        })
    }

    fn history_writing(&self) -> bool {
        self.with(|hooks| self.ports.call_port(&hooks.history_writing, ()))
            .and_then(Result::ok)
            .unwrap_or(false)
    }

    fn live_write_blocked(&self) -> bool {
        self.with(|hooks| self.ports.call_port(&hooks.live_write_blocked, ()))
            .and_then(Result::ok)
            .unwrap_or(false)
    }

    fn prepare_live_write(&self, bytes: f64) -> Result<(), EngineError> {
        match self.with(|hooks| self.ports.call_port(&hooks.prepare_live_write, bytes)) {
            Some(Ok(None)) => Ok(()),
            Some(Ok(Some(message))) | Some(Err(PortError::Threw(message))) => {
                Err(EngineError::Port(PortError::Threw(message)))
            }
            Some(Err(error)) => Err(EngineError::Port(error)),
            None => Err(EngineError::Port(PortError::Unbound("the live admission"))),
        }
    }

    fn buffer_live_write(
        &self,
        thread: &str,
        events: &[Value],
        at: f64,
        _snapshot: Rc<dyn LiveSnapshot>,
    ) -> Result<(), EngineError> {
        let text = ace_json::to_string(&ace_json::json!({
            "thread": thread.to_string(),
            "events": Value::Array(events.to_vec().into()),
            "at": at,
        }));
        match self.with(|hooks| self.ports.call_port(&hooks.buffer_live_write, text)) {
            Some(Ok(None)) => Ok(()),
            Some(Ok(Some(message))) | Some(Err(PortError::Threw(message))) => {
                Err(EngineError::Port(PortError::Threw(message)))
            }
            Some(Err(error)) => Err(EngineError::Port(error)),
            None => Err(EngineError::Port(PortError::Unbound("the live buffer"))),
        }
    }

    fn flush_due(&self) {
        let _ = self.with(|hooks| self.ports.call_port(&hooks.flush_due, ()));
    }

    fn flush_live_writes(&self) {
        let _ = self.with(|hooks| self.ports.call_port(&hooks.flush_live_writes, ()));
    }

    fn is_store_retry(&self, error: &EngineError) -> bool {
        match error {
            // `isStoreRetry` for a store error: busy or disk full.
            EngineError::Store(source) => {
                source.kind == ace_store::ErrorKind::Sqlite && matches!(source.code & 0xff, 5 | 13)
            }
            _ => self
                .with(|hooks| {
                    self.ports
                        .call_port(&hooks.is_store_retry, error.to_string())
                })
                .and_then(Result::ok)
                .unwrap_or(false),
        }
    }
}

/// Builds the actor runtime: production owners plus the shell's live store and promises.
pub fn runtime(
    ports: Rc<JsPorts>,
    idle_ms: f64,
) -> (Rc<ActorRuntime>, Rc<RefCell<Option<LiveHooks>>>) {
    let hooks = Rc::new(RefCell::new(None));
    let live = Rc::new(JsLiveStore {
        ports: Rc::clone(&ports),
        hooks: Rc::clone(&hooks),
    });
    let acks = Rc::new(JsAcks {
        ports: Rc::clone(&ports),
    });
    let deps = Rc::new(ActorDeps::new(
        Rc::new(Unported),
        Rc::new(Unported),
        Rc::clone(&live) as Rc<dyn LiveStore>,
        Rc::clone(&acks) as Rc<dyn FrameAcks>,
        idle_ms,
    ));
    (
        Rc::new(ActorRuntime {
            deps,
            live,
            acks,
            helper: RefCell::new(None),
            flows: RefCell::new(HashMap::new()),
            #[cfg(feature = "engine-probe")]
            probe: RefCell::new(None),
        }),
        hooks,
    )
}

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
                for actor in state.actors.by_thread.values() {
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
            .with_state(|state| {
                state
                    .actors
                    .by_thread
                    .get(&thread_id)
                    .map(|actor| actor.generation)
            })
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
        generation: f64,
        handle: f64,
        frame: Object,
        is_object: bool,
        certified: bool,
        bytes: Option<f64>,
        measure_error: Option<String>,
        call: f64,
    ) -> napi::Result<String> {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let envelope = super::frames::read_envelope(&frame, is_object, certified)?;
        let channel_sdk = super::frames::string_property(&frame, "channel")
            .is_some_and(|channel| channel == "sdk");
        let measure = match (bytes, measure_error) {
            (Some(bytes), _) => Measure::Certified {
                bytes: bytes as usize,
            },
            (None, Some(message)) => Measure::Bounded(Err(message)),
            (None, None) => Measure::Bounded(Ok(0)),
        };
        let ack = intake::frame(
            core,
            &thread_id,
            generation as u64,
            FrameInput {
                frame: FrameRef::Js {
                    handle: handle as u32,
                    sdk: channel_sdk,
                },
                envelope,
                channel_sdk,
                measure,
            },
            Some(call as u64),
        );
        Ok(match ack {
            intake::Ack::Done => "done".to_string(),
            intake::Ack::Rejected(message) => format!("rejected:{message}"),
            intake::Ack::Batch => "batch".to_string(),
            intake::Ack::AfterFlush(receiver) => {
                let ports = Rc::clone(&self.ports);
                let core = Rc::clone(core);
                let task = core.executor.spawn(Lane::Work, async move {
                    let _ = receiver.await;
                    ports.settle_call(call as u64, None);
                });
                task.detach();
                "flush".to_string()
            }
        })
    }

    /// `outputFlow.paused` (`actor.ts:85`).
    #[napi]
    pub fn actor_paused(&self, env: Env, thread_id: String) -> bool {
        let _guard = self.ports.enter(env);
        ace_engine::actor::flow::paused(self.engine.core(), &thread_id)
    }

    /// `outputFlow.wait` (`actor.ts:87`).
    #[napi]
    pub fn actor_wait(&self, env: Env, thread_id: String, call: f64) {
        let _guard = self.ports.enter(env);
        let ports = Rc::clone(&self.ports);
        let inner = Rc::clone(self.engine.core());
        let executor = Rc::clone(&inner);
        let task = inner.executor.spawn(Lane::Work, async move {
            ace_engine::actor::flow::wait(executor, thread_id).await;
            ports.settle_call(call as u64, None);
        });
        task.detach();
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
            flush_due: hooks
                .get_named_property("flushDue")
                .map_err(|_| napi::Error::from_reason("flushDue is missing"))?,
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
