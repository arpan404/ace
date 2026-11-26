// SPDX-License-Identifier: Apache-2.0
//! One session's shared state and its ordered event queue: every input (a chunk from the child,
//! a binding call, a timer) runs under the wire's one lock, and the drainer hands the queue's
//! events to the engine's session interface in the order they were produced.
//!
//! This module owns the lock, the child's exit, the terminal barrier and the stop plan's call;
//! the open composition is `open.rs` and the `Session` methods are `methods.rs`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ace_adapter_api::bridge::{SessionErrorWire, SessionEvent};
use ace_adapter_api::{SessionExit, SessionFrame, SessionObserver};
use ace_json::{Map, Raw, Value};
use ace_supervisor::divert::OutputConsumer;
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};
use futures::future::BoxFuture;
use indexmap::IndexMap;
use tokio::sync::{oneshot, watch};

use super::clock::{Clock, Timer};
use super::error::{PiError, Refused, Uncertain};
use super::io::PiSessionCore;
use super::lease::PiLease;
use super::open::PiSessionError;
use super::shell::{ChildExit, PiChild};

/// The batch bound the drainer takes (`bridge.rs`, E3.0c).
const BATCH_FRAMES: usize = 256;
const BATCH_BYTES: usize = 256 * 1024;
/// `proc.stop({ graceMs: 1000 })` (`session.ts:299`).
pub const STOP_GRACE: Duration = Duration::from_millis(1_000);
/// The stop plan's poll interval (`process-owner.ts:379`).
const STOP_POLL: f64 = 25.0;

/// One session's shared state. The drainer, the child's consumer and every session method
/// clone the same `Arc`.
pub(crate) struct Inner {
    pub(crate) core: Arc<PiSessionCore>,
    observer: Arc<dyn SessionObserver>,
    pub(crate) clock: Arc<dyn Clock>,
    timer: Arc<dyn Timer>,
    runtime: tokio::runtime::Handle,
    /// Set once the child is spawned, as the TypeScript sets `started` after `io.spawn`.
    started: OnceLock<f64>,
    pub(crate) child: Mutex<Option<Arc<PiChild>>>,
    exit: Arc<ChildExit>,
    /// Request ids awaiting their one settlement.
    pending: Mutex<IndexMap<u64, oneshot::Sender<Result<String, SessionErrorWire>>>>,
    timers: Mutex<IndexMap<String, Box<dyn Fn() + Send + Sync>>>,
    next_id: AtomicU64,
    pub(crate) closed: AtomicBool,
    pub(crate) closing: AtomicBool,
    control: AtomicBool,
    deliberate: AtomicBool,
    drained: Latch,
    /// The close's admission: a write commits in the same synchronous turn as the close
    /// check (`native-session.ts:259`-`:270`), so a fatal close cannot slip between them.
    write_gate: WriteGate,
    released: std::sync::Once,
    config: Mutex<Option<super::config::PrivateMcpConfig>>,
    lease: Option<PiLease>,
    close_lock: tokio::sync::Mutex<()>,
}

impl Inner {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        core: Arc<PiSessionCore>,
        exit: Arc<ChildExit>,
        observer: Arc<dyn SessionObserver>,
        clock: Arc<dyn Clock>,
        timer: Arc<dyn Timer>,
        runtime: tokio::runtime::Handle,
        config: super::config::PrivateMcpConfig,
        lease: Option<PiLease>,
    ) -> Self {
        Self {
            core,
            observer,
            clock,
            timer,
            runtime,
            started: OnceLock::new(),
            child: Mutex::new(None),
            exit,
            pending: Mutex::new(IndexMap::new()),
            timers: Mutex::new(IndexMap::new()),
            next_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            control: AtomicBool::new(false),
            deliberate: AtomicBool::new(false),
            drained: Latch::new(),
            write_gate: WriteGate::new(),
            released: std::sync::Once::new(),
            config: Mutex::new(Some(config)),
            lease,
            close_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// The child exists now: frame times start here, as `started = io.now()` follows the spawn.
    pub(crate) fn spawned(&self, child: Arc<PiChild>, started: f64) {
        let _ = self.started.set(started);
        *self.child.lock().unwrap_or_else(|error| error.into_inner()) = Some(child);
    }

    fn started(&self) -> f64 {
        self.started.get().copied().unwrap_or_default()
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// `rpc.request` (`rpc.ts:80`): the id, the write, then the settlement the queue carries.
    /// A close that began first refuses the command, so the send is never taken.
    pub(crate) async fn request(
        &self,
        command: &str,
        params: &Map,
    ) -> Result<String, PiSessionError> {
        let id = self.next_id();
        let (sender, receiver) = oneshot::channel();
        // The check, the pending entry and the write are one turn: a fatal close either
        // happens before all of them (the write never reaches Pi) or after all of them.
        let committed = self.write_gate.commit(|| {
            if self.closed.load(Ordering::Acquire) || self.closing.load(Ordering::Acquire) {
                return Err(PiSessionError::from_pi(PiError::refused(Refused::Closed)));
            }
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(id, sender);
            self.core
                .request(command, params, id)
                .map_err(PiSessionError::from_pi)
        });
        let Some(committed) = committed else {
            return Err(PiSessionError::from_pi(PiError::refused(Refused::Closed)));
        };
        if let Err(error) = committed {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .shift_remove(&id);
            return Err(error);
        }
        match receiver.await {
            Ok(result) => result.map_err(PiSessionError::from_wire),
            // The queue settled nothing: the session is gone, and the write may have reached Pi.
            Err(_) => Err(PiSessionError::Uncertain(Uncertain::Closed.to_string())),
        }
    }

    /// `rpc.write` for a dialog answer.
    pub(crate) async fn write(&self, data: &Map, resume_after: bool) -> Result<(), PiSessionError> {
        let id = self.next_id();
        let (sender, receiver) = oneshot::channel();
        let committed = self.write_gate.commit(|| {
            if self.closed.load(Ordering::Acquire) || self.closing.load(Ordering::Acquire) {
                return Err(PiSessionError::from_pi(PiError::refused(Refused::Closed)));
            }
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(id, sender);
            self.core
                .write(data, id, resume_after)
                .map_err(PiSessionError::from_pi)
        });
        let Some(committed) = committed else {
            return Err(PiSessionError::from_pi(PiError::refused(Refused::Closed)));
        };
        if let Err(error) = committed {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .shift_remove(&id);
            return Err(error);
        }
        match receiver.await {
            Ok(result) => result.map(|_| ()).map_err(PiSessionError::from_wire),
            Err(_) => Err(PiSessionError::Uncertain(Uncertain::Closed.to_string())),
        }
    }

    pub(crate) fn check_open(&self) -> Result<(), PiSessionError> {
        if self.closed.load(Ordering::Acquire) || self.closing.load(Ordering::Acquire) {
            return Err(PiSessionError::Closed);
        }
        Ok(())
    }

    /// `check()`: open, and not inside a history operation.
    pub(crate) fn check(&self) -> Result<(), PiSessionError> {
        self.check_open()?;
        if self.control.load(Ordering::Acquire) {
            return Err(PiSessionError::Control);
        }
        Ok(())
    }

    /// The child's leader ended: the session is stopping, its credentials end now
    /// (`session.ts:307`–`:313`), and what the leader left behind in its group is killed
    /// (`killGroupOnExit`, `process.ts:303`).
    pub(crate) fn on_exit(&self, exit: RawExit) {
        self.exit.record(exit);
        self.closed.store(true, Ordering::SeqCst);
        self.release();
        let child = self
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(child) = child {
            child.kill_group_on_exit();
        }
    }

    /// `configuration.remove()` and `lease?.end()`, exactly once.
    pub(crate) fn release(&self) {
        self.released.call_once(|| {
            let config = self
                .config
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(config) = config {
                config.remove();
            }
            if let Some(lease) = &self.lease {
                lease.end();
            }
        });
    }

    /// The terminal barrier: every frame the child produced has been delivered. `Latch` reads
    /// through a `watch`, which records the change before any waiter polls, so a drain that
    /// lands between a caller's check and its wait is never lost.
    pub(crate) async fn await_drained(&self) {
        self.drained.wait().await;
    }

    fn arm_timer(&self, key: String, ms: f64) {
        let core = Arc::clone(&self.core);
        let fired = key.clone();
        let guard = self.timer.after(
            ms,
            Box::new(move || {
                core.timer(&fired);
            }),
        );
        let previous = self
            .timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key, guard);
        if let Some(previous) = previous {
            previous();
        }
    }

    fn cancel_timer(&self, key: &str) {
        let guard = self
            .timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shift_remove(key);
        if let Some(guard) = guard {
            guard();
        }
    }

    fn cancel_timers(&self) {
        let guards: Vec<_> = self
            .timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
            .map(|(_, guard)| guard)
            .collect();
        for guard in guards {
            guard();
        }
    }

    /// The stop plan (`process.ts:358`–`:400`): hold the group, SIGTERM, poll until the group is
    /// gone, SIGKILL at the grace.
    /// Whether nothing of the child's group runs: close waits for this, not only its pipes.
    pub(crate) fn group_gone(&self) -> bool {
        self.child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_none_or(|child| child.group_gone())
    }

    pub(crate) async fn stop_process(&self) -> Result<(), PiSessionError> {
        let child = self
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let Some(child) = child else {
            return Ok(());
        };
        child
            .stop(STOP_GRACE, self.timer.as_ref(), STOP_POLL)
            .await
            .map_err(|error| PiSessionError::Supervisor(error.to_string()))
    }

    /// Close or stop, retryable: a failed stop leaves the session stop-only, and a retried
    /// close runs the plan again (`native-session.ts:358`–`:380`).
    pub(crate) async fn close(&self, deliberate: bool) -> Result<(), PiSessionError> {
        let _guard = self.close_lock.lock().await;
        if self.closed.load(Ordering::Acquire) && self.drained.is_open() && self.group_gone() {
            return Ok(());
        }
        let previous = self.deliberate.swap(deliberate, Ordering::SeqCst);
        // The admission closes first: a write already committing finishes, and every later one
        // is refused without reaching the wire.
        self.write_gate.close();
        self.closing.store(true, Ordering::SeqCst);
        // The cancellation of ADR 0223 §7 rule 4: read on to EOF, still queueing every frame.
        self.core.gate().drain();
        if let Err(error) = self.stop_process().await {
            self.deliberate.store(previous, Ordering::SeqCst);
            self.core.gate().undrain();
            return Err(error);
        }
        self.await_drained().await;
        self.dispose();
        self.cancel_timers();
        self.release();
        Ok(())
    }

    /// Frees the child's pipes and stdin task (`process.ts:295`-`:298`), so a closed session
    /// retains no sink, observer or state.
    pub(crate) fn dispose(&self) {
        let child = self
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(child) = child {
            child.dispose();
        }
    }

    /// A close nobody awaits: its failure is noted, as `stopFailed` does.
    pub(crate) fn fatal(self: &Arc<Self>) {
        let inner = Arc::clone(self);
        self.runtime.spawn(async move {
            if let Err(error) = inner.close(false).await {
                inner.note_stop_failed(&error.to_string());
            }
        });
    }

    pub(crate) fn note_stop_failed(&self, message: &str) {
        let mut map = Map::with_capacity(2);
        map.insert("event", Value::from("stop-failed"));
        map.insert("message", Value::from(message));
        self.core.note(&ace_json::to_string(&Value::Object(map)));
    }
}

/// Where the child's events reach the session core, and its exit the session.
pub(crate) struct SessionConsumer {
    pub(crate) inner: Arc<Inner>,
}

impl OutputConsumer for SessionConsumer {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.inner.core.output(stream, bytes, delivered);
    }

    fn end(&self, stream: OutputStream) {
        self.inner.core.end(stream);
    }

    fn stdin_written(&self) {
        self.inner.core.stdin_written();
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.inner.core.stdin_error(error);
    }

    fn exit(&self, exit: RawExit) {
        self.inner.core.exit(exit.clone());
        self.inner.on_exit(exit);
    }

    fn close(&self, exit: RawExit) {
        self.inner.core.close(exit.clone());
        self.inner.exit.record(exit);
    }
}

/// The ordered queue's one consumer: every event in the order the wire produced it, handed to
/// the engine's session interface (E3.0c's bridge, with the observer in place of JavaScript).
pub(crate) fn drain(inner: Arc<Inner>) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        loop {
            inner.core.queue().wait().await;
            let batch = inner.core.queue().take_batch(BATCH_FRAMES, BATCH_BYTES);
            for event in batch {
                match event {
                    SessionEvent::Frame {
                        seq,
                        dir,
                        channel,
                        text,
                    } => {
                        // Admission already proved the text is JSON; a failure here would be a
                        // bug in the wire, so it is logged rather than silently lost.
                        let Ok(data) = Raw::from_string(text) else {
                            eprintln!("pi session: a frame's text was not JSON");
                            continue;
                        };
                        let t = (inner.clock.now() - inner.started()).round().max(0.0) as i64;
                        inner.observer.frame(SessionFrame {
                            seq,
                            t,
                            dir,
                            channel,
                            data,
                        });
                    }
                    SessionEvent::Settle { id, result } => {
                        let sender = inner
                            .pending
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .shift_remove(&id);
                        if let Some(sender) = sender {
                            let _ = sender.send(result);
                        }
                    }
                    SessionEvent::ArmTimer { key, ms } => inner.arm_timer(key, ms),
                    SessionEvent::CancelTimer { key } => inner.cancel_timer(&key),
                    SessionEvent::Fatal { message } => {
                        inner.observer.fatal(&message);
                        inner.fatal();
                    }
                    SessionEvent::Drained => {
                        inner.dispose();
                        inner.cancel_timers();
                        inner.release();
                        inner.drained.open();
                        let deliberate = inner.deliberate.load(Ordering::SeqCst);
                        let exit = inner.exit.get();
                        let reason = if deliberate {
                            "stopped"
                        } else if exit
                            .as_ref()
                            .and_then(|exit| exit.signal.as_deref())
                            .is_some()
                        {
                            "signal"
                        } else {
                            "exit"
                        };
                        let code = exit
                            .and_then(|exit| exit.code)
                            .map_or_else(|| "null".to_owned(), |code| code.to_string());
                        inner.observer.exit(SessionExit {
                            deliberate,
                            message: format!("Pi process {reason}, code {code}"),
                        });
                        return;
                    }
                    SessionEvent::Callback { .. } | SessionEvent::Port { .. } => {}
                }
            }
        }
    })
}

/// Serializes a close's check with a write's commit. `commit` runs its closure while holding
/// the lock and only while open; `close` takes the same lock before closing, so a write either
/// commits entirely before the close or not at all.
pub(crate) struct WriteGate {
    open: AtomicBool,
    gate: Mutex<()>,
}

impl WriteGate {
    pub(crate) fn new() -> WriteGate {
        WriteGate {
            open: AtomicBool::new(true),
            gate: Mutex::new(()),
        }
    }

    /// Runs `write` if the gate is open; `None` once it is closed.
    pub(crate) fn commit<T>(&self, write: impl FnOnce() -> T) -> Option<T> {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        if !self.open.load(Ordering::SeqCst) {
            return None;
        }
        Some(write())
    }

    /// Closes the gate, waiting for a write already committing to finish.
    pub(crate) fn close(&self) {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        self.open.store(false, Ordering::SeqCst);
    }
}

/// A one-shot terminal flag that cannot lose its wakeup: `watch` keeps the value's version, so
/// a reader that subscribes after `open` still sees it and one already waiting is woken.
pub(crate) struct Latch {
    sender: watch::Sender<bool>,
    /// Kept so the channel never closes with no reader: an `open` before the first waiter
    /// must still record the value.
    _receiver: watch::Receiver<bool>,
}

impl Latch {
    pub(crate) fn new() -> Latch {
        let (sender, receiver) = watch::channel(false);
        Latch {
            sender,
            _receiver: receiver,
        }
    }

    /// Opens the latch; a second call is harmless.
    pub(crate) fn open(&self) {
        let _ = self.sender.send(true);
    }

    pub(crate) fn is_open(&self) -> bool {
        *self.sender.borrow()
    }

    pub(crate) async fn wait(&self) {
        let mut receiver = self.sender.subscribe();
        loop {
            // `borrow_and_update` marks the version seen, so `changed()` wakes for any later
            // open; an open before the subscription is read right here.
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // The lost-wakeup guard for the terminal barrier (`native-session.ts:375`–`:376`): the
    // TypeScript awaits a latch, and these cases exercise ours from before, during and in a
    // tight race with the open.
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_close_waits_for_a_write_already_committing_and_refuses_the_next() {
        let gate = Arc::new(WriteGate::new());
        let (committing, committed) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let writer = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                gate.commit(|| {
                    committing.send(()).expect("signal");
                    released.recv().expect("release");
                })
                .is_some()
            })
        };
        committed.recv().expect("the write started");
        let closer = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || gate.close())
        };
        // The close is held until the in-flight write commits.
        std::thread::sleep(std::time::Duration::from_millis(25));
        release.send(()).expect("release the write");
        closer.join().expect("closer");
        assert!(
            writer.join().expect("writer"),
            "the in-flight write was refused"
        );
        assert!(
            gate.commit(|| ()).is_none(),
            "a write after the close reached the wire"
        );
    }

    #[tokio::test]
    async fn a_latch_opened_before_its_reader_resolves_at_once() {
        let latch = Latch::new();
        latch.open();
        tokio::time::timeout(Duration::from_millis(100), latch.wait())
            .await
            .expect("an open latch did not resolve");
    }

    #[tokio::test]
    async fn a_latch_opened_while_readers_wait_wakes_every_one() {
        let latch = Arc::new(Latch::new());
        let mut readers = Vec::new();
        for _ in 0..8 {
            let latch = Arc::clone(&latch);
            readers.push(tokio::spawn(async move { latch.wait().await }));
        }
        // Let every reader subscribe before the open lands.
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        latch.open();
        for reader in readers {
            tokio::time::timeout(Duration::from_millis(100), reader)
                .await
                .expect("a waiting reader was never woken")
                .expect("reader");
        }
    }

    #[tokio::test]
    async fn a_thousand_opens_racing_their_readers_never_lose_one() {
        for _ in 0..1_000 {
            let latch = Arc::new(Latch::new());
            let reader = {
                let latch = Arc::clone(&latch);
                tokio::spawn(async move {
                    latch.wait().await;
                })
            };
            // The reader subscribes first: the race this guards is an open between the read
            // and the registration, not an open before the wait ever starts.
            tokio::task::yield_now().await;
            latch.open();
            tokio::time::timeout(Duration::from_secs(1), reader)
                .await
                .expect("a reader lost the open")
                .expect("reader");
        }
    }
}
