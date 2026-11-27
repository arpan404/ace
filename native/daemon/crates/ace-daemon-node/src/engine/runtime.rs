// SPDX-License-Identifier: Apache-2.0
//! The actor runtime's non-binding half (E5.2 step 13): the dependencies the engine holds, the
//! shell's frame promises, and the live-buffer hooks and their snapshot tokens.

use ace_engine::actor::deps::{ActorDeps, FrameAcks, Unported};
use ace_engine::actor::flow::NativeFlow;
use ace_engine::frames::live::{LiveSnapshot, LiveStore};
use ace_engine::futures::future::LocalBoxFuture;
use ace_engine::ports::{PortError, Ports};
use ace_engine::{Core, EngineError};
use ace_json::Value;
use napi::bindgen_prelude::FunctionRef;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use super::js_translator::Helper;
use super::ports::JsPorts;

pub struct ActorRuntime {
    pub deps: Rc<ActorDeps>,
    pub live: Rc<JsLiveStore>,
    pub acks: Rc<JsAcks>,
    /// The shell's batch helper, installed by `actorContext`.
    pub helper: RefCell<Option<Rc<Helper>>>,
    /// Each native session's flow mirror.
    pub flows: RefCell<HashMap<String, NativeFlow>>,
    /// The buffered live writes' snapshots by token: the shell calls `persist` and `committed`
    /// back for an engine-sourced entry (E5.2 step 16).
    pub snapshots: Rc<RefCell<HashMap<u64, Rc<dyn LiveSnapshot>>>>,
    pub next_snapshot: Rc<std::cell::Cell<u64>>,
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
    fn alloc(&self) -> Option<u64> {
        self.ports.frame_call()
    }

    fn settle(&self, call: u64, reject: Option<String>) {
        self.ports.settle_call(call, reject);
    }

    fn release(&self, handles: &[u32]) {
        self.ports
            .release_frames(&ace_json::to_string(&ace_json::Value::Array(
                handles
                    .iter()
                    .map(|handle| (*handle as u64).into())
                    .collect::<Vec<ace_json::Value>>()
                    .into(),
            )));
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
    pub run_scheduled: FunctionRef<(), ()>,
    pub flush_live_writes: FunctionRef<(), ()>,
    pub is_store_retry: FunctionRef<String, bool>,
}

/// `LiveStore` over the shell's public store methods.
pub struct JsLiveStore {
    ports: Rc<JsPorts>,
    hooks: Rc<RefCell<Option<LiveHooks>>>,
    snapshots: Rc<RefCell<HashMap<u64, Rc<dyn LiveSnapshot>>>>,
    next_snapshot: Rc<std::cell::Cell<u64>>,
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
        snapshot: Rc<dyn LiveSnapshot>,
    ) -> Result<(), EngineError> {
        let token = self.next_snapshot.get() + 1;
        self.next_snapshot.set(token);
        self.snapshots.borrow_mut().insert(token, snapshot);
        let text = ace_json::to_string(&ace_json::json!({
            "thread": thread.to_string(),
            "events": Value::Array(events.to_vec().into()),
            "at": at,
            "token": token,
        }));
        match self.with(|hooks| self.ports.call_port(&hooks.buffer_live_write, text)) {
            Some(Ok(None)) => Ok(()),
            Some(Ok(Some(message))) | Some(Err(PortError::Threw(message))) => {
                self.snapshots.borrow_mut().remove(&token);
                Err(EngineError::Port(PortError::Threw(message)))
            }
            Some(Err(error)) => {
                self.snapshots.borrow_mut().remove(&token);
                Err(EngineError::Port(error))
            }
            None => {
                self.snapshots.borrow_mut().remove(&token);
                Err(EngineError::Port(PortError::Unbound("the live buffer")))
            }
        }
    }

    fn run_scheduled(&self) {
        let _ = self.with(|hooks| self.ports.call_port(&hooks.run_scheduled, ()));
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
    let snapshots: Rc<RefCell<HashMap<u64, Rc<dyn LiveSnapshot>>>> =
        Rc::new(RefCell::new(HashMap::new()));
    let next_snapshot = Rc::new(std::cell::Cell::new(0));
    let live = Rc::new(JsLiveStore {
        ports: Rc::clone(&ports),
        hooks: Rc::clone(&hooks),
        snapshots: Rc::clone(&snapshots),
        next_snapshot: Rc::clone(&next_snapshot),
    });
    let acks = Rc::new(JsAcks {
        ports: Rc::clone(&ports),
    });
    let deps = Rc::new(ActorDeps::new(
        Rc::new(ace_engine::repository::actor_repo::EngineRepo),
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
            snapshots,
            next_snapshot,
            #[cfg(feature = "engine-probe")]
            probe: RefCell::new(None),
        }),
        hooks,
    )
}
