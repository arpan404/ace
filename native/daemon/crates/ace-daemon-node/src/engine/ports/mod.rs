// SPDX-License-Identifier: Apache-2.0
//! The engine's JavaScript ports (E5.1 step 5). Every `EngineOptions` port is one JavaScript
//! function the shell handed over; a call borrows the `Env` of the entry that is running (the
//! pump, a facade call, a timer firing, a promise's `then`), so a port reached from a tokio
//! thread with none in scope is `PortError::NoEnv`, never a panic.
//!
//! Timers and awaited promises use ids rather than function arguments Rust cannot type: the
//! shell arms a timer for `key` and calls `timerFired(key)`; a promise it must await is
//! registered by id and settles through `settlePromise(id, ok)`.

use ace_engine::futures::future::LocalBoxFuture;
use ace_engine::ports::PortError;
use napi::Env;
use napi::bindgen_prelude::{FnArgs, FromNapiValue, FunctionRef};
use napi_derive::napi;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use id::UuidV7;
use promises::Pending;
use timers::{ArmTimer, ArmedTimer};

mod binding;
mod id;
mod promises;
mod timers;

/// The shell's `open()` result.
#[napi(object)]
pub struct OpenFrameJs {
    pub token: f64,
    pub outermost: bool,
}

/// `options.selectInstance`: the account a provider runs on by default.
type SelectInstance = FunctionRef<FnArgs<(String, Option<String>)>, Option<String>>;

/// `options.recovery.resetAt`'s answer, tagged so undefined, null and a time stay distinct.
#[napi(object)]
pub struct ResetAtJs {
    pub tag: String,
    pub at: Option<f64>,
}

/// Every port the engine calls, as function references.
pub struct JsPorts {
    env: Cell<Option<Env>>,
    clock_now: FunctionRef<(), f64>,
    arm_timer: ArmTimer,
    arm_batch_timer: ArmTimer,
    thread_id: FunctionRef<(), String>,
    command_id: FunctionRef<(), String>,
    next_id: FunctionRef<String, String>,
    report: FunctionRef<String, ()>,
    providers_activated: FunctionRef<f64, ()>,
    wait_for_provider: FunctionRef<FnArgs<(String, f64)>, ()>,
    resolve_ready: FunctionRef<Option<String>, ()>,
    resolve_close: FunctionRef<Option<String>, ()>,
    open_transaction: FunctionRef<(), OpenFrameJs>,
    close_transaction: FunctionRef<FnArgs<(f64, Option<String>)>, ()>,
    is_transaction_open: FunctionRef<(), bool>,
    append_events: FunctionRef<String, ()>,
    write_events: FunctionRef<FnArgs<(String, String, f64)>, ()>,
    head_seq: FunctionRef<(), f64>,
    has_live_write: FunctionRef<String, bool>,
    rollback_generation: FunctionRef<(), f64>,
    get_thread: FunctionRef<String, Option<String>>,
    on_naming_prompt: FunctionRef<FnArgs<(String, String)>, ()>,
    cap_raw: FunctionRef<FnArgs<(String, String)>, String>,
    prepare_live_write: FunctionRef<f64, ()>,
    buffer_live_write: FunctionRef<FnArgs<(String, String, f64, f64)>, ()>,
    frame_call: FunctionRef<(), f64>,
    release_frames: FunctionRef<String, ()>,
    settle_call: FunctionRef<FnArgs<(f64, Option<String>)>, ()>,
    reject_pending: FunctionRef<(), ()>,
    finish_close: FunctionRef<(), ()>,
    provider_enabled: FunctionRef<FnArgs<(String, Option<String>)>, bool>,
    has_move_target: bool,
    has_reset_at: bool,
    admits: FunctionRef<(), bool>,
    reset_at: Option<FunctionRef<String, ResetAtJs>>,
    select_instance: Option<SelectInstance>,
    models_resolve: Option<FunctionRef<String, String>>,
    models_list: Option<FunctionRef<String, String>>,
    models_update_permission_modes: Option<FunctionRef<FnArgs<(String, String)>, ()>>,
    timers: RefCell<HashMap<u64, ArmedTimer>>,
    /// The Rust port of `timeOrderedIds` (`time-ordered-id.ts:11`), used when no `ids` port
    /// was given: the same UUIDv7 layout, the clock and random bytes from the OS.
    ids: RefCell<UuidV7>,
    promises: RefCell<HashMap<u64, Pending>>,
    next_timer: Cell<u64>,
    next_promise: Cell<u64>,
    /// Event writes a receipt holds back until its state borrow is released: `writeEvents` can
    /// call back into the engine (a `store.onWrite` hook reads `rootAgent`), which the borrow
    /// would refuse. `Some` while a receipt runs, in call order.
    deferred_events: RefCell<Option<Vec<(String, String, f64)>>>,
}

fn threw(error: napi::Error) -> PortError {
    PortError::Threw(error.reason.clone())
}

impl JsPorts {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        env: Env,
        clock_now: FunctionRef<(), f64>,
        arm_timer: ArmTimer,
        arm_batch_timer: ArmTimer,
        thread_id: FunctionRef<(), String>,
        command_id: FunctionRef<(), String>,
        next_id: FunctionRef<String, String>,
        report: FunctionRef<String, ()>,
        providers_activated: FunctionRef<f64, ()>,
        wait_for_provider: FunctionRef<FnArgs<(String, f64)>, ()>,
        resolve_ready: FunctionRef<Option<String>, ()>,
        resolve_close: FunctionRef<Option<String>, ()>,
        open_transaction: FunctionRef<(), OpenFrameJs>,
        close_transaction: FunctionRef<FnArgs<(f64, Option<String>)>, ()>,
        is_transaction_open: FunctionRef<(), bool>,
        append_events: FunctionRef<String, ()>,
        write_events: FunctionRef<FnArgs<(String, String, f64)>, ()>,
        head_seq: FunctionRef<(), f64>,
        has_live_write: FunctionRef<String, bool>,
        rollback_generation: FunctionRef<(), f64>,
        get_thread: FunctionRef<String, Option<String>>,
        on_naming_prompt: FunctionRef<FnArgs<(String, String)>, ()>,
        cap_raw: FunctionRef<FnArgs<(String, String)>, String>,
        prepare_live_write: FunctionRef<f64, ()>,
        buffer_live_write: FunctionRef<FnArgs<(String, String, f64, f64)>, ()>,
        frame_call: FunctionRef<(), f64>,
        release_frames: FunctionRef<String, ()>,
        settle_call: FunctionRef<FnArgs<(f64, Option<String>)>, ()>,
        reject_pending: FunctionRef<(), ()>,
        finish_close: FunctionRef<(), ()>,
        provider_enabled: FunctionRef<FnArgs<(String, Option<String>)>, bool>,
        has_move_target: bool,
        has_reset_at: bool,
        admits: FunctionRef<(), bool>,
        reset_at: Option<FunctionRef<String, ResetAtJs>>,
        select_instance: Option<SelectInstance>,
        models_resolve: Option<FunctionRef<String, String>>,
        models_list: Option<FunctionRef<String, String>>,
        models_update_permission_modes: Option<FunctionRef<FnArgs<(String, String)>, ()>>,
    ) -> napi::Result<JsPorts> {
        Ok(JsPorts {
            env: Cell::new(Some(env)),
            clock_now,
            arm_timer,
            arm_batch_timer,
            thread_id,
            command_id,
            next_id,
            report,
            providers_activated,
            wait_for_provider,
            resolve_ready,
            resolve_close,
            open_transaction,
            close_transaction,
            is_transaction_open,
            append_events,
            write_events,
            head_seq,
            has_live_write,
            rollback_generation,
            get_thread,
            on_naming_prompt,
            cap_raw,
            prepare_live_write,
            buffer_live_write,
            frame_call,
            release_frames,
            settle_call,
            reject_pending,
            finish_close,
            provider_enabled,
            has_move_target,
            has_reset_at,
            admits,
            reset_at,
            select_instance,
            models_resolve,
            models_list,
            models_update_permission_modes,
            timers: RefCell::new(HashMap::new()),
            ids: RefCell::new(UuidV7::default()),
            promises: RefCell::new(HashMap::new()),
            deferred_events: RefCell::new(None),
            next_timer: Cell::new(1),
            next_promise: Cell::new(1),
        })
    }

    /// Installs the entry's `Env` for the duration of a call, restoring the previous one.
    pub fn enter(&self, env: Env) -> EnvGuard<'_> {
        let previous = self.env.replace(Some(env));
        EnvGuard {
            ports: self,
            previous,
        }
    }

    /// Holds the receipt's event writes back (`true`) or lets them through (`false`).
    pub fn defer_events(&self, defer: bool) {
        let mut slot = self.deferred_events.borrow_mut();
        if defer {
            if slot.is_none() {
                *slot = Some(Vec::new());
            }
        } else {
            *slot = None;
        }
    }

    /// The writes the receipt held back, in call order, and the end of the deferral.
    pub fn take_deferred_events(&self) -> Vec<(String, String, f64)> {
        self.deferred_events.borrow_mut().take().unwrap_or_default()
    }

    /// The writes held back so far, leaving the deferral on for the rest of the receipt.
    pub fn drain_deferred_events(&self) -> Vec<(String, String, f64)> {
        self.deferred_events
            .borrow_mut()
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default()
    }

    /// Any function-reference port call, for the modules that hold their own function refs.
    pub fn call_port<A, R>(&self, function: &FunctionRef<A, R>, args: A) -> Result<R, PortError>
    where
        A: napi::bindgen_prelude::JsValuesTupleIntoVec,
        R: FromNapiValue,
    {
        self.call(function, args)
    }

    fn env(&self) -> Result<Env, PortError> {
        self.env.get().ok_or(PortError::NoEnv)
    }

    fn call<A, R>(&self, function: &FunctionRef<A, R>, args: A) -> Result<R, PortError>
    where
        A: napi::bindgen_prelude::JsValuesTupleIntoVec,
        R: FromNapiValue,
    {
        let env = self.env()?;
        let function = function.borrow_back(&env).map_err(threw)?;
        function.call(args).map_err(threw)
    }

    /// The `waitForProvider` promise, registered under a label for close's report.
    pub fn wait_for_provider_message(
        &self,
        provider: &str,
        message: Option<String>,
    ) -> LocalBoxFuture<'static, Result<(), PortError>> {
        let (id, receiver) = self.arm_promise(message);
        if let Err(error) = self.call(
            &self.wait_for_provider,
            FnArgs {
                data: (provider.to_string(), id as f64),
            },
        ) {
            return Box::pin(async move { Err(error) });
        }
        Box::pin(async move { receiver.await.map_err(|_| PortError::NoEnv)? })
    }
}

/// Restores the previous `Env` when the entry returns.
pub struct EnvGuard<'a> {
    ports: &'a JsPorts,
    previous: Option<Env>,
}

impl Drop for EnvGuard<'_> {
    fn drop(&mut self) {
        self.ports.env.set(self.previous);
    }
}
