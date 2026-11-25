// SPDX-License-Identifier: Apache-2.0
//! The engine's JavaScript ports (E5.1 step 5). Every `EngineOptions` port is one JavaScript
//! function the shell handed over; a call borrows the `Env` of the entry that is running (the
//! pump, a facade call, a timer firing, a promise's `then`), so a port reached from a tokio
//! thread with none in scope is `PortError::NoEnv`, never a panic.
//!
//! Timers and awaited promises use ids rather than function arguments Rust cannot type: the
//! shell arms a timer for `key` and calls `timerFired(key)`; a promise it must await is
//! registered by id and settles through `settlePromise(id, ok)`.

use ace_engine::futures::channel::oneshot;
use ace_engine::futures::future::LocalBoxFuture;
use ace_engine::ports::{OpenFrame, PortError, Ports, Timer};
use napi::Env;
use napi::bindgen_prelude::{FnArgs, FromNapiValue, FunctionRef};
use napi_derive::napi;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

/// The shell's `open()` result.
#[napi(object)]
pub struct OpenFrameJs {
    pub token: f64,
    pub outermost: bool,
}

/// `timeOrderedIds`: UUIDv7, monotonic within one process, an id never repeats.
#[derive(Default)]
struct UuidV7 {
    last_ms: u64,
    counter: u16,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    let _ = getrandom::fill(&mut bytes);
    bytes
}

impl UuidV7 {
    fn next(&mut self) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0);
        if now > self.last_ms {
            self.last_ms = now;
            // A random start within the lower half leaves room to count up in the same
            // millisecond.
            let seed = random_bytes::<2>();
            self.counter = ((u16::from(seed[0]) << 8) | u16::from(seed[1])) & 0x7ff;
        } else {
            self.counter += 1;
            if self.counter > 0xfff {
                self.last_ms += 1;
                self.counter = 0;
            }
        }
        let mut bytes = [0u8; 16];
        let mut rest = self.last_ms;
        for index in (0..6).rev() {
            bytes[index] = (rest % 256) as u8;
            rest /= 256;
        }
        bytes[6] = 0x70 | ((self.counter >> 8) & 0x0f) as u8;
        bytes[7] = (self.counter & 0xff) as u8;
        let tail = random_bytes::<8>();
        bytes[8] = 0x80 | (tail[0] & 0x3f);
        bytes[9..16].copy_from_slice(&tail[1..8]);
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    }
}

struct ArmedTimer {
    sender: Option<oneshot::Sender<()>>,
    cancel: Option<FunctionRef<(), ()>>,
}

struct Pending {
    sender: Option<oneshot::Sender<Result<(), PortError>>>,
    /// Reported once through `onError` if close finds it still pending.
    message: Option<String>,
}

/// A timer that returns the shell's cancel function.
type ArmTimer = FunctionRef<FnArgs<(f64, f64)>, Option<FunctionRef<(), ()>>>;

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
    cap_raw: FunctionRef<FnArgs<(String, String)>, String>,
    prepare_live_write: FunctionRef<f64, ()>,
    buffer_live_write: FunctionRef<FnArgs<(String, String, f64, f64)>, ()>,
    settle_call: FunctionRef<FnArgs<(f64, Option<String>)>, ()>,
    reject_pending: FunctionRef<(), ()>,
    finish_close: FunctionRef<(), ()>,
    timers: RefCell<HashMap<u64, ArmedTimer>>,
    /// The Rust port of `timeOrderedIds` (`time-ordered-id.ts:11`), used when no `ids` port
    /// was given: the same UUIDv7 layout, the clock and random bytes from the OS.
    ids: RefCell<UuidV7>,
    promises: RefCell<HashMap<u64, Pending>>,
    next_timer: Cell<u64>,
    next_promise: Cell<u64>,
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
        cap_raw: FunctionRef<FnArgs<(String, String)>, String>,
        prepare_live_write: FunctionRef<f64, ()>,
        buffer_live_write: FunctionRef<FnArgs<(String, String, f64, f64)>, ()>,
        settle_call: FunctionRef<FnArgs<(f64, Option<String>)>, ()>,
        reject_pending: FunctionRef<(), ()>,
        finish_close: FunctionRef<(), ()>,
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
            cap_raw,
            prepare_live_write,
            buffer_live_write,
            settle_call,
            reject_pending,
            finish_close,
            timers: RefCell::new(HashMap::new()),
            ids: RefCell::new(UuidV7::default()),
            promises: RefCell::new(HashMap::new()),
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

    /// A promise to await: the shell settles it through `settlePromise(id, ok)`.
    pub fn arm_promise(
        &self,
        message: Option<String>,
    ) -> (u64, oneshot::Receiver<Result<(), PortError>>) {
        let id = self.next_promise.get();
        self.next_promise.set(id + 1);
        let (sender, receiver) = oneshot::channel();
        self.promises.borrow_mut().insert(
            id,
            Pending {
                sender: Some(sender),
                message,
            },
        );
        (id, receiver)
    }

    fn arm_with(&self, timer: &ArmTimer, ms: f64) -> Timer {
        let key = self.next_timer.get();
        self.next_timer.set(key + 1);
        let (sender, receiver) = oneshot::channel();
        self.timers.borrow_mut().insert(
            key,
            ArmedTimer {
                sender: Some(sender),
                cancel: None,
            },
        );
        let cancel = self
            .call(
                timer,
                FnArgs {
                    data: (key as f64, ms),
                },
            )
            .ok()
            .flatten();
        if let Some(entry) = self.timers.borrow_mut().get_mut(&key) {
            entry.cancel = cancel;
        }
        Timer {
            key,
            fired: receiver,
        }
    }

    /// Timers still armed, for the probe's close check.
    #[cfg(feature = "engine-probe")]
    pub fn timer_count(&self) -> usize {
        self.timers.borrow().len()
    }

    /// A timer fired: its waiting task becomes runnable (the send is the producer's wake).
    pub fn timer_fired(&self, key: u64) {
        let sender = self
            .timers
            .borrow_mut()
            .get_mut(&key)
            .and_then(|entry| entry.sender.take());
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }

    /// A promise settled: `false` rejects it with the JavaScript error's message.
    pub fn settle_promise(&self, id: u64, ok: bool, message: Option<String>) {
        let sender = self
            .promises
            .borrow_mut()
            .get_mut(&id)
            .and_then(|entry| entry.sender.take());
        if let Some(sender) = sender {
            let _ = sender.send(if ok {
                Ok(())
            } else {
                Err(PortError::Threw(
                    message.unwrap_or_else(|| "engine promise rejected".into()),
                ))
            });
        }
    }

    /// Close's step 5: report every abandoned promise once, then drop them all.
    pub fn abandon_promises(&self) {
        let pending: Vec<Pending> = self.promises.borrow_mut().drain().map(|(_, p)| p).collect();
        for mut entry in pending {
            if let Some(message) = entry.message.take() {
                self.report_now(&message);
            }
            entry.sender.take();
        }
    }

    fn report_now(&self, message: &str) {
        let _ = self.call(&self.report, message.to_string());
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

impl Ports for JsPorts {
    fn now(&self) -> f64 {
        self.call(&self.clock_now, ()).unwrap_or_default()
    }

    fn set_timer(&self, ms: f64) -> Timer {
        self.arm_with(&self.arm_timer, ms)
    }

    fn cancel_timer(&self, key: u64) {
        if let Some(entry) = self.timers.borrow_mut().remove(&key)
            && let Some(cancel) = entry.cancel
        {
            let _ = self.call(&cancel, ());
        }
    }

    fn cancel_all_timers(&self) {
        let timers: Vec<ArmedTimer> = self.timers.borrow_mut().drain().map(|(_, t)| t).collect();
        for mut entry in timers {
            if let Some(cancel) = entry.cancel.take() {
                let _ = self.call(&cancel, ());
            }
            entry.sender.take();
        }
    }

    fn set_batch_timer(&self, ms: f64) -> Timer {
        self.arm_with(&self.arm_batch_timer, ms)
    }

    fn thread_id(&self) -> String {
        let given = self.call(&self.thread_id, ()).unwrap_or_default();
        if given.is_empty() {
            return self.ids.borrow_mut().next();
        }
        given
    }

    fn command_id(&self) -> String {
        let given = self.call(&self.command_id, ()).unwrap_or_default();
        if given.is_empty() {
            return self.ids.borrow_mut().next();
        }
        given
    }

    fn next_id(&self, kind: &str) -> String {
        let given = self
            .call(&self.next_id, kind.to_string())
            .unwrap_or_default();
        if given.is_empty() {
            return self.ids.borrow_mut().next();
        }
        given
    }

    fn report(&self, error: String) {
        let _ = self.call(&self.report, error);
    }

    fn providers_activated(&self) -> LocalBoxFuture<'static, Result<(), PortError>> {
        let (id, receiver) = self.arm_promise(None);
        if let Err(error) = self.call(&self.providers_activated, id as f64) {
            return Box::pin(async move { Err(error) });
        }
        Box::pin(async move { receiver.await.map_err(|_| PortError::NoEnv)? })
    }

    fn wait_for_provider(&self, provider: &str) -> LocalBoxFuture<'static, Result<(), PortError>> {
        JsPorts::wait_for_provider_message(self, provider, None)
    }

    fn resolve_ready(&self, error: Option<String>) {
        let _ = self.call(&self.resolve_ready, error);
    }

    fn resolve_close(&self, error: Option<String>) {
        let _ = self.call(&self.resolve_close, error);
    }

    fn is_transaction_open(&self) -> bool {
        self.call(&self.is_transaction_open, ()).unwrap_or(false)
    }

    fn open_transaction(&self) -> Result<OpenFrame, PortError> {
        let frame = self.call(&self.open_transaction, ())?;
        Ok(OpenFrame {
            token: frame.token as u64,
            outermost: frame.outermost,
        })
    }

    fn close_transaction(&self, frame: u64, error: Option<String>) -> Result<(), PortError> {
        self.call(
            &self.close_transaction,
            FnArgs {
                data: (frame as f64, error),
            },
        )
    }

    fn append_events(&self, json: &str) -> Result<(), PortError> {
        self.call(&self.append_events, json.to_string())
    }

    fn write_events(&self, thread: &str, payloads_json: &str, at: f64) -> Result<(), PortError> {
        self.call(
            &self.write_events,
            FnArgs {
                data: (thread.to_owned(), payloads_json.to_owned(), at),
            },
        )
    }

    fn head_seq(&self) -> Result<f64, PortError> {
        self.call(&self.head_seq, ())
    }

    fn has_live_write(&self, thread: &str) -> Result<bool, PortError> {
        self.call(&self.has_live_write, thread.to_owned())
    }

    fn rollback_generation(&self) -> Result<f64, PortError> {
        self.call(&self.rollback_generation, ())
    }

    fn get_thread(&self, thread: &str) -> Result<Option<String>, PortError> {
        self.call(&self.get_thread, thread.to_owned())
    }

    fn cap_raw(&self, thread: &str, raw: &str) -> Result<String, PortError> {
        self.call(
            &self.cap_raw,
            FnArgs {
                data: (raw.to_owned(), thread.to_owned()),
            },
        )
    }

    fn prepare_live_write(&self, bytes: f64) -> Result<(), PortError> {
        self.call(&self.prepare_live_write, bytes)
    }

    fn buffer_live_write(
        &self,
        thread: &str,
        events_json: &str,
        at: f64,
        token: u64,
    ) -> Result<(), PortError> {
        self.call(
            &self.buffer_live_write,
            FnArgs {
                data: (thread.to_owned(), events_json.to_owned(), at, token as f64),
            },
        )
    }

    fn settle_call(&self, call: u64, error: Option<String>) {
        let _ = self.call(
            &self.settle_call,
            FnArgs {
                data: (call as f64, error),
            },
        );
    }

    fn reject_pending(&self) {
        self.abandon_promises();
        let _ = self.call(&self.reject_pending, ());
    }

    fn finish_close(&self) {
        let _ = self.call(&self.finish_close, ());
    }
}
