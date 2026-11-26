// SPDX-License-Identifier: Apache-2.0
//! The native engine's constructor (E5.1): the shell's bindings, the inputs it declares, the
//! ports over them and the one transaction stack both sides open.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};

use ace_engine::ports::Ports;
use ace_engine::{Engine, Inputs};
use napi::Env;
use napi::bindgen_prelude::{FnArgs, FunctionRef, JsObjectValue, Object};
use napi_derive::napi;

use super::ports::JsPorts;
use super::{Bell, NativeEngine, PumpHandle, SharedStack, Sink, actor, engine_error, transaction};
#[cfg(feature = "engine-probe")]
use super::{probe, probe_actor};
use crate::NativeDatabase;

#[napi]
impl NativeDatabase {
    /// The native engine over this connection and its one transaction stack.
    #[napi]
    pub fn native_engine(
        &self,
        env: Env,
        bindings: Object,
        pump: napi::bindgen_prelude::Function<(), ()>,
    ) -> napi::Result<NativeEngine> {
        let options_json = bindings
            .get_named_property::<String>("options")
            .map_err(|_| napi::Error::from_reason("engine options are missing"))?;
        let registry_json = bindings
            .get_named_property::<String>("registry")
            .unwrap_or_default();
        let parsed = ace_json::parse(&options_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let inputs = read_inputs(&parsed);
        let ports = Rc::new(JsPorts::new(
            env,
            bindings
                .get_named_property("clockNow")
                .map_err(|_| napi::Error::from_reason("clockNow is missing"))?,
            bindings
                .get_named_property("armTimer")
                .map_err(|_| napi::Error::from_reason("armTimer is missing"))?,
            bindings
                .get_named_property("armBatchTimer")
                .map_err(|_| napi::Error::from_reason("armBatchTimer is missing"))?,
            bindings
                .get_named_property("threadId")
                .map_err(|_| napi::Error::from_reason("threadId is missing"))?,
            bindings
                .get_named_property("commandId")
                .map_err(|_| napi::Error::from_reason("commandId is missing"))?,
            bindings
                .get_named_property("nextId")
                .map_err(|_| napi::Error::from_reason("nextId is missing"))?,
            bindings
                .get_named_property("report")
                .map_err(|_| napi::Error::from_reason("report is missing"))?,
            bindings
                .get_named_property("providersActivated")
                .map_err(|_| napi::Error::from_reason("providersActivated is missing"))?,
            bindings
                .get_named_property("waitForProvider")
                .map_err(|_| napi::Error::from_reason("waitForProvider is missing"))?,
            bindings
                .get_named_property("resolveReady")
                .map_err(|_| napi::Error::from_reason("resolveReady is missing"))?,
            bindings
                .get_named_property("resolveClose")
                .map_err(|_| napi::Error::from_reason("resolveClose is missing"))?,
            bindings
                .get_named_property("openTransaction")
                .map_err(|_| napi::Error::from_reason("openTransaction is missing"))?,
            bindings
                .get_named_property("closeTransaction")
                .map_err(|_| napi::Error::from_reason("closeTransaction is missing"))?,
            bindings
                .get_named_property("isTransactionOpen")
                .map_err(|_| napi::Error::from_reason("isTransactionOpen is missing"))?,
            bindings
                .get_named_property("appendEvents")
                .map_err(|_| napi::Error::from_reason("appendEvents is missing"))?,
            bindings
                .get_named_property("writeEvents")
                .map_err(|_| napi::Error::from_reason("writeEvents is missing"))?,
            bindings
                .get_named_property("headSeq")
                .map_err(|_| napi::Error::from_reason("headSeq is missing"))?,
            bindings
                .get_named_property("hasLiveWrite")
                .map_err(|_| napi::Error::from_reason("hasLiveWrite is missing"))?,
            bindings
                .get_named_property("rollbackGeneration")
                .map_err(|_| napi::Error::from_reason("rollbackGeneration is missing"))?,
            bindings
                .get_named_property("getThread")
                .map_err(|_| napi::Error::from_reason("getThread is missing"))?,
            bindings
                .get_named_property("onNamingPrompt")
                .map_err(|_| napi::Error::from_reason("onNamingPrompt is missing"))?,
            bindings
                .get_named_property("capRaw")
                .map_err(|_| napi::Error::from_reason("capRaw is missing"))?,
            bindings
                .get_named_property("prepareLiveWrite")
                .map_err(|_| napi::Error::from_reason("prepareLiveWrite is missing"))?,
            bindings
                .get_named_property("bufferLiveWrite")
                .map_err(|_| napi::Error::from_reason("bufferLiveWrite is missing"))?,
            bindings
                .get_named_property("frameCall")
                .map_err(|_| napi::Error::from_reason("frameCall is missing"))?,
            bindings
                .get_named_property("releaseFrames")
                .map_err(|_| napi::Error::from_reason("releaseFrames is missing"))?,
            bindings
                .get_named_property("settleCall")
                .map_err(|_| napi::Error::from_reason("settleCall is missing"))?,
            bindings
                .get_named_property("rejectPending")
                .map_err(|_| napi::Error::from_reason("rejectPending is missing"))?,
            bindings
                .get_named_property("finishClose")
                .map_err(|_| napi::Error::from_reason("finishClose is missing"))?,
            bindings
                .get_named_property("providerEnabled")
                .map_err(|_| napi::Error::from_reason("providerEnabled is missing"))?,
            bindings
                .get_named_property("hasMoveTarget")
                .map_err(|_| napi::Error::from_reason("hasMoveTarget is missing"))?,
            bindings
                .get_named_property("hasResetAt")
                .map_err(|_| napi::Error::from_reason("hasResetAt is missing"))?,
            bindings
                .get_named_property("admits")
                .map_err(|_| napi::Error::from_reason("admits is missing"))?,
            bindings
                .get_named_property::<FunctionRef<String, super::ports::ResetAtJs>>("resetAt")
                .ok(),
            bindings.get_named_property("selectInstance").ok(),
            bindings
                .get_named_property::<FunctionRef<String, String>>("modelsResolve")
                .ok(),
            bindings
                .get_named_property::<FunctionRef<String, String>>("modelsList")
                .ok(),
            bindings
                .get_named_property::<FunctionRef<FnArgs<(String, String)>, ()>>(
                    "modelsUpdatePermissionModes",
                )
                .ok(),
        )?);
        let stack = self.transaction_state();
        let pump: PumpHandle = Arc::new(Mutex::new(Some(
            pump.build_threadsafe_function::<()>()
                .callee_handled::<false>()
                .max_queue_size::<0>()
                .build()?,
        )));
        let bell = Bell {
            pump: Arc::clone(&pump),
        };
        // The actor's dependencies (E5.2 correction 6). Until the shell's live buffer is wired,
        // the store seam names the item that lands it.
        let idle_ms = ace_engine::limits::validate_idle_ms(inputs.idle_ms.unwrap_or(0.0))
            .map_err(engine_error)?;
        let (actor_runtime, live_hooks) = self::actor::runtime(Rc::clone(&ports), idle_ms);
        let deps = Rc::clone(&actor_runtime.deps);
        let engine = Engine::new(
            Rc::clone(&ports) as Rc<dyn Ports>,
            Rc::new(SharedStack {
                state: Rc::clone(&stack),
            }),
            inputs,
            &registry_json,
            Box::new(bell),
            self.connection(),
            deps,
        )
        .map_err(engine_error)?;
        let sink = Rc::new(Sink {
            after: Rc::clone(&engine.core().after),
        });
        transaction::attach_sink(
            &stack,
            Rc::downgrade(&sink) as Weak<dyn transaction::AfterCommitSink>,
        );
        let engine = Rc::new(engine);
        let native = NativeEngine {
            engine,
            ports,
            _sink: sink,
            pump,
            holders: Cell::new(0),
            limit_policies: RefCell::new(HashMap::new()),
            #[cfg(feature = "engine-probe")]
            probe: Rc::new(RefCell::new(probe::ProbeState::new(std::sync::Arc::clone(
                self.connection(),
            )))),
            #[cfg(feature = "engine-probe")]
            stack,
            actor: actor_runtime,
            live_hooks,
            #[cfg(feature = "engine-probe")]
            probe_threads: Rc::new(RefCell::new(probe_actor::ProbeThreads::default())),
        };
        let _ = env;
        Ok(native)
    }
}

fn read_inputs(options: &ace_json::Value) -> Inputs {
    let mut inputs = Inputs::default();
    let field = |name: &str| match options {
        ace_json::Value::Object(map) => map.get(name),
        _ => None,
    };
    let number = |name: &str| match field(name) {
        Some(ace_json::Value::Number(value)) => value.as_f64(),
        _ => None,
    };
    if let Some(ace_json::Value::Object(limits)) = field("limits") {
        let limit = |name: &str| match limits.get(name) {
            Some(ace_json::Value::Number(value)) => value.as_f64(),
            _ => None,
        };
        inputs.limits = ace_engine::limits::LimitOverrides {
            max_active_threads: limit("maxActiveThreads"),
            max_queued_frames: limit("maxQueuedFrames"),
            max_queued_bytes: limit("maxQueuedBytes"),
            max_frame_bytes: limit("maxFrameBytes"),
            max_pending_inputs: limit("maxPendingInputs"),
            max_input_bytes: limit("maxInputBytes"),
        };
    }
    inputs.idle_ms = number("idleMs");
    if let Some(ace_json::Value::Object(ready)) = field("inputs") {
        let flag = |name: &str| matches!(ready.get(name), Some(ace_json::Value::Bool(true)));
        inputs.has_preferences = flag("preferences");
        inputs.has_models = flag("models");
        inputs.has_providers_activated = flag("providersActivated");
        inputs.has_resolve_silence = flag("resolveSilenceMs");
    }
    inputs
}
