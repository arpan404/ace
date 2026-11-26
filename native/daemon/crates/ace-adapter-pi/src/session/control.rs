// SPDX-License-Identifier: Apache-2.0
//! Pi's control composition in Rust (E3-pi.3): `openPiSession`'s open-time work and its
//! session, as `ace_adapter_api::Session`, with no JavaScript in between.
//!
//! Ported from `packages/adapter-pi/src/session.ts:56`–`:508` (`openPiSession`) and the native
//! facade `native-session.ts:89`–`:555`. The per-line half is `session/wire.rs`; this file owns
//! the launch, the child, the request/answer pairing, the stop plan and the model/effort
//! selection. Frames, identity, fatal failures and the exit go to
//! `ace_adapter_api::SessionObserver` (the engine's session interface, E5.6).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ace_adapter_api::AdapterApiError;
use ace_adapter_api::bridge::{SessionErrorWire, SessionEvent};
use ace_adapter_api::{
    CloseReason, Delivery, InputSource, InterruptTarget, Reopen, SendInput, Session, SessionExit,
    SessionFrame, SessionObserver, assert_steer_target,
};
use ace_json::{JsString, Map, Raw, Value};
use ace_protocol::generated::{ExecutionSelection, GoalChange, InteractionResolution};
use ace_supervisor::divert::OutputConsumer;
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};
use futures::future::LocalBoxFuture;
use indexmap::IndexMap;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use super::command::{content_part_values, native_command_inputs};
use super::config::{ConfigError, PrivateMcpConfig, write_private_config};
use super::error::{PiError, Uncertain};
use super::history::PiHistoryError;
use super::io::{COMMAND_REFUSED, PiSessionCore, UNCERTAIN};
use super::launch::{PiLaunchError, PiLaunchInput, pi_launch};
use super::reference::{
    CheckedReference, SessionReference, checked_session_reference, encode_session_reference,
    load_session_reference, save_session_reference,
};
use super::resolve::{PiDialogError, dialog_response};
use super::shell::{ChildExit, PiChild};
use super::version::{PiCliError, require_readable_pi};
use super::wire::PiWireConfig;
use crate::input::{PiInput, PiInputError, pi_input};

/// `clear_queue`, `abort` and `abort_bash`: the interrupt's three requests (`session.ts:429`–`:431`).
const INTERRUPT_COMMANDS: [&str; 3] = ["clear_queue", "abort", "abort_bash"];
/// `proc.stop({ graceMs: 1000 })` (`session.ts:299`).
const STOP_GRACE: Duration = Duration::from_millis(1_000);
/// The force stop's own wait, so a kill that cannot land still ends the plan.
const KILL_WAIT: Duration = Duration::from_millis(1_000);
/// The batch bound the drainer takes (`bridge.rs`, E3.0c).
const BATCH_FRAMES: usize = 256;
const BATCH_BYTES: usize = 256 * 1024;

/// The daemon's clock for frame times (`io.now`); injected, so a test fixes it.
pub trait PiClock: Send + Sync + 'static {
    /// Milliseconds since any fixed origin; only differences matter.
    fn now(&self) -> f64;
}

/// The default clock: a monotonic reading, started when the daemon asks for one.
pub struct MonotonicClock {
    origin: std::time::Instant,
}

impl MonotonicClock {
    pub fn start() -> Self {
        Self {
            origin: std::time::Instant::now(),
        }
    }
}

impl PiClock for MonotonicClock {
    fn now(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1_000.0
    }
}

/// The daemon's existing session lease (`ctx.aceMcp`): capabilities and revocation it already
/// owns. The session ends it once, however it closes.
pub struct PiLease {
    pub url: String,
    pub bearer: String,
    end: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl PiLease {
    pub fn new(url: String, bearer: String, end: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            url,
            bearer,
            end: Mutex::new(Some(Box::new(end))),
        }
    }

    fn end(&self) {
        let end = self
            .end
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(end) = end {
            end();
        }
    }
}

/// Everything one open needs. The daemon supplies discovery's path and version, the person's
/// environment, the reference directory and the engine's observer.
pub struct PiSessionOpen {
    pub launch: PiLaunchInput,
    /// `ctx.rootKey ?? "root"`.
    pub root_key: String,
    /// The control secret `io.secret()` makes: one per session, 64 hex characters.
    pub control_secret: String,
    pub lease: Option<PiLease>,
    pub reference_dir: PathBuf,
    /// Where the private credential directory is made (the temp directory).
    pub config_root: PathBuf,
    /// One per session; names the private directory so two opens never collide.
    pub nonce: String,
    /// `io.processKey()`: the identity the translator namespaces Pi's keys with.
    pub process_id: String,
    /// `ctx.resume.nativeSessionId`: the stored reference to resume.
    pub resume: Option<String>,
    pub observer: Arc<dyn SessionObserver>,
    pub clock: Arc<dyn PiClock>,
    /// `maxOutputBytes`: undefined for sessions, as today.
    pub max_output_bytes: Option<u64>,
}

/// Why an open or a session method failed. Provider-derived strings only cross as the wire's
/// own messages.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiSessionError {
    #[error("Pi session closed")]
    Closed,
    #[error("Pi history operation in progress")]
    Control,
    #[error("ace Pi extension did not load")]
    Extension,
    #[error("{0}")]
    Cli(#[from] PiCliError),
    #[error("{0}")]
    Launch(#[from] PiLaunchError),
    #[error("{0}")]
    History(#[from] PiHistoryError),
    #[error("{0}")]
    Config(#[from] ConfigError),
    #[error("{0}")]
    Dialog(#[from] PiDialogError),
    #[error("{0}")]
    Input(#[from] PiInputError),
    #[error("{0}")]
    Command(#[from] super::command::PiCommandError),
    #[error("Pi could not start: {0}")]
    Spawn(String),
    #[error("Pi process supervision: {0}")]
    Supervisor(String),
    #[error("Invalid Pi state")]
    State,
    #[error("Pi session identity changed")]
    Identity,
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Uncertain(String),
    #[error("{0}")]
    Unavailable(String),
}

impl PiSessionError {
    fn from_pi(error: PiError) -> Self {
        match error {
            PiError::Refused(kind) => PiSessionError::Refused(kind.to_string()),
            PiError::Uncertain(kind) => PiSessionError::Uncertain(kind.to_string()),
        }
    }

    /// A settlement as the queue carries it (`io.rs:282`–`:293`): the code decides the side.
    fn from_wire(error: SessionErrorWire) -> Self {
        if error.code == COMMAND_REFUSED {
            PiSessionError::Refused(error.message)
        } else if error.code == UNCERTAIN {
            PiSessionError::Uncertain(error.message)
        } else {
            // An unknown code is a plain error today, so it never proves a refusal.
            PiSessionError::Uncertain(error.message)
        }
    }

    /// A session method's error: a refusal proves nothing ran, anything else stays uncertain.
    fn into_adapter(self) -> AdapterApiError {
        match self {
            PiSessionError::Refused(message) => AdapterApiError::InputRejected(message),
            PiSessionError::History(error) => AdapterApiError::InputRejected(error.to_string()),
            PiSessionError::Dialog(error) => AdapterApiError::InputRejected(error.to_string()),
            PiSessionError::Input(error) => AdapterApiError::InputRejected(error.to_string()),
            PiSessionError::Command(error) => AdapterApiError::InputRejected(error.to_string()),
            other => AdapterApiError::Transport(other.to_string()),
        }
    }
}

/// A state reply's fields (`native.ts:24`–`:30`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct PiState {
    session_file: String,
    session_id: String,
    is_streaming: bool,
    is_compacting: bool,
    pending_message_count: u64,
}

/// One session's shared state. The drainer, the child's consumer and every session method
/// clone the same `Arc`.
struct Inner {
    core: Arc<PiSessionCore>,
    observer: Arc<dyn SessionObserver>,
    clock: Arc<dyn PiClock>,
    started: f64,
    runtime: Handle,
    child: Mutex<Option<Arc<PiChild>>>,
    exit: Arc<ChildExit>,
    /// Request ids awaiting their one settlement.
    pending: Mutex<IndexMap<u64, oneshot::Sender<Result<String, SessionErrorWire>>>>,
    timers: Mutex<IndexMap<String, tokio::task::JoinHandle<()>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    closing: AtomicBool,
    control: AtomicBool,
    deliberate: AtomicBool,
    drained: AtomicBool,
    drained_notify: tokio::sync::Notify,
    released: std::sync::Once,
    config: Mutex<Option<PrivateMcpConfig>>,
    lease: Option<PiLease>,
    close_lock: tokio::sync::Mutex<()>,
}

impl Inner {
    fn new(
        core: Arc<PiSessionCore>,
        exit: Arc<ChildExit>,
        observer: Arc<dyn SessionObserver>,
        clock: Arc<dyn PiClock>,
        runtime: Handle,
        config: PrivateMcpConfig,
        lease: Option<PiLease>,
    ) -> Self {
        let started = clock.now();
        Self {
            core,
            observer,
            clock,
            started,
            runtime,
            child: Mutex::new(None),
            exit,
            pending: Mutex::new(IndexMap::new()),
            timers: Mutex::new(IndexMap::new()),
            next_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            control: AtomicBool::new(false),
            deliberate: AtomicBool::new(false),
            drained: AtomicBool::new(false),
            drained_notify: tokio::sync::Notify::new(),
            released: std::sync::Once::new(),
            config: Mutex::new(Some(config)),
            lease,
            close_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// `rpc.request` (`rpc.ts:80`): the id, the write, then the settlement the queue carries.
    async fn request(&self, command: &str, params: &Map) -> Result<String, PiSessionError> {
        self.check_open()?;
        let id = self.next_id();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, sender);
        if let Err(error) = self.core.request(command, params, id) {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .shift_remove(&id);
            return Err(PiSessionError::from_pi(error));
        }
        match receiver.await {
            Ok(result) => result.map_err(PiSessionError::from_wire),
            // The queue settled nothing: the session is gone.
            Err(_) => Err(PiSessionError::Uncertain(Uncertain::Closed.to_string())),
        }
    }

    /// `rpc.write` for a dialog answer.
    async fn write(&self, data: &Map, resume_after: bool) -> Result<(), PiSessionError> {
        self.check_open()?;
        let id = self.next_id();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, sender);
        if let Err(error) = self.core.write(data, id, resume_after) {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .shift_remove(&id);
            return Err(PiSessionError::from_pi(error));
        }
        match receiver.await {
            Ok(result) => result.map(|_| ()).map_err(PiSessionError::from_wire),
            Err(_) => Err(PiSessionError::Uncertain(Uncertain::Closed.to_string())),
        }
    }

    fn check_open(&self) -> Result<(), PiSessionError> {
        if self.closed.load(Ordering::Acquire) || self.closing.load(Ordering::Acquire) {
            return Err(PiSessionError::Closed);
        }
        Ok(())
    }

    /// `check()`: open, and not inside a history operation.
    fn check(&self) -> Result<(), PiSessionError> {
        self.check_open()?;
        if self.control.load(Ordering::Acquire) {
            return Err(PiSessionError::Control);
        }
        Ok(())
    }

    /// The child's leader ended: the session is stopping, so its credentials end now
    /// (`session.ts:307`–`:313`).
    fn on_exit(&self, exit: RawExit) {
        self.exit.record(exit);
        self.closed.store(true, Ordering::SeqCst);
        self.release();
    }

    /// `configuration.remove()` and `lease?.end()`, exactly once.
    fn release(&self) {
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

    /// The terminal barrier: every frame the child produced has been delivered.
    async fn await_drained(&self) {
        loop {
            if self.drained.load(Ordering::Acquire) {
                return;
            }
            self.drained_notify.notified().await;
        }
    }

    fn arm_timer(self: &Arc<Self>, key: String, ms: f64) {
        let inner = Arc::clone(self);
        let fired = key.clone();
        let handle = self.runtime.spawn(async move {
            let ms = if ms.is_finite() && ms > 0.0 { ms } else { 0.0 };
            tokio::time::sleep(Duration::from_secs_f64(ms / 1_000.0)).await;
            inner.core.timer(&fired);
        });
        let previous = self
            .timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key, handle);
        if let Some(previous) = previous {
            previous.abort();
        }
    }

    fn cancel_timer(&self, key: &str) {
        let handle = self
            .timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shift_remove(key);
        if let Some(handle) = handle {
            handle.abort();
        }
    }

    fn cancel_timers(&self) {
        let timers: Vec<_> = self
            .timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
            .map(|(_, handle)| handle)
            .collect();
        for handle in timers {
            handle.abort();
        }
    }

    /// The stop plan (`session.ts:299`, native `stopProcess` `:338`–`:357`): hold the group,
    /// SIGTERM, then SIGKILL after the grace, and wait for the leader's exit.
    async fn stop_process(&self) -> Result<(), PiSessionError> {
        let Some(child) = self
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        else {
            return Ok(());
        };
        // The polite Windows stop is EOF; POSIX gets SIGTERM to the whole group.
        child.hold();
        if cfg!(windows) {
            child.end_stdin();
        }
        if let Err(error) = child.signal_group(SignalName::Term) {
            child.unhold();
            return Err(PiSessionError::Supervisor(error.to_string()));
        }
        let settled = tokio::time::timeout(STOP_GRACE, self.exit.wait())
            .await
            .is_ok();
        if !settled {
            if let Err(error) = child.signal_group(SignalName::Kill) {
                child.unhold();
                return Err(PiSessionError::Supervisor(error.to_string()));
            }
            let _ = tokio::time::timeout(KILL_WAIT, self.exit.wait()).await;
        }
        child.unhold();
        Ok(())
    }

    /// Close or stop, retryable: a failed stop leaves the session stop-only, and a retried
    /// close runs the plan again (`native-session.ts:358`–`:380`).
    async fn close(&self, deliberate: bool) -> Result<(), PiSessionError> {
        let _guard = self.close_lock.lock().await;
        if self.closed.load(Ordering::Acquire) && self.drained.load(Ordering::Acquire) {
            return Ok(());
        }
        let previous = self.deliberate.swap(deliberate, Ordering::SeqCst);
        self.closing.store(true, Ordering::SeqCst);
        // The cancellation of ADR 0223 §7 rule 4: read on to EOF, still queueing every frame.
        self.core.gate().drain();
        if let Err(error) = self.stop_process().await {
            self.deliberate.store(previous, Ordering::SeqCst);
            self.core.gate().undrain();
            return Err(error);
        }
        self.await_drained().await;
        self.cancel_timers();
        self.release();
        Ok(())
    }

    /// A close nobody awaits: its failure is noted, as `stopFailed` does.
    fn fatal(self: &Arc<Self>) {
        let inner = Arc::clone(self);
        self.runtime.spawn(async move {
            if let Err(error) = inner.close(false).await {
                inner.note_stop_failed(&error.to_string());
            }
        });
    }

    fn note_stop_failed(&self, message: &str) {
        let mut map = Map::with_capacity(2);
        map.insert("event", Value::from("stop-failed"));
        map.insert("message", Value::from(message));
        self.core.note(&ace_json::to_string(&Value::Object(map)));
    }
}

/// Where the child's events reach the session core, and its exit the session.
struct SessionConsumer {
    inner: Arc<Inner>,
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
async fn drain(inner: Arc<Inner>) {
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
                    let t = (inner.clock.now() - inner.started).round().max(0.0) as i64;
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
                    inner.cancel_timers();
                    inner.release();
                    inner.drained.store(true, Ordering::SeqCst);
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
                    inner.drained_notify.notify_waiters();
                    return;
                }
                SessionEvent::Callback { .. } | SessionEvent::Port { .. } => {}
            }
        }
    }
}

/// One open Pi session, as the engine holds it.
pub struct PiSession {
    inner: Arc<Inner>,
    native_id: String,
    native_file: String,
    root_key: String,
    control_secret: String,
    model: Option<String>,
    effort: Option<String>,
}

/// `openPiSession` (`session.ts:56`): the version gate, the resume reference, the private
/// configuration, the launch and spawn, then the extension check and the identity.
pub async fn open_pi_session(
    open: PiSessionOpen,
    runtime: &Handle,
) -> Result<PiSession, PiSessionError> {
    require_readable_pi(open.launch.version.as_deref())?;
    let resume = match &open.resume {
        Some(value) => Some(load_session_reference(&open.reference_dir, value)?),
        None => None,
    };
    let content = config_content(&open);
    let config = write_private_config(
        &open.config_root,
        &open.nonce,
        &content,
        Some(Path::new(&open.launch.cwd)),
    )?;
    // The spawn's environment names the file just written.
    let mut launch_input = open.launch.clone();
    launch_input.session_file = config.path.to_string_lossy().to_string();
    let launch = match pi_launch(&launch_input) {
        Ok(launch) => launch,
        Err(error) => {
            config.remove();
            return Err(error.into());
        }
    };

    let lease_bearer = open.lease.as_ref().map(|lease| lease.bearer.clone());
    let core = Arc::new(PiSessionCore::new(PiWireConfig {
        control_secret: open.control_secret.clone(),
        lease_bearer,
    }));
    let exit = Arc::new(ChildExit::default());
    let inner = Arc::new(Inner::new(
        Arc::clone(&core),
        Arc::clone(&exit),
        Arc::clone(&open.observer),
        Arc::clone(&open.clock),
        runtime.clone(),
        config,
        open.lease,
    ));
    let consumer: Arc<dyn OutputConsumer> = Arc::new(SessionConsumer {
        inner: Arc::clone(&inner),
    });
    let ports = Arc::clone(core.ports());
    let child = match PiChild::spawn(&launch, consumer, ports, runtime, open.max_output_bytes) {
        Ok(child) => Arc::new(child),
        Err(error) => {
            // No child will ever report: close the wire so its port releases, clean up, fail.
            core.abandon();
            inner.release();
            return Err(PiSessionError::Spawn(error.to_string()));
        }
    };
    *inner
        .child
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(Arc::clone(&child));
    runtime.spawn(drain(Arc::clone(&inner)));

    let opened = async {
        let mut note = Map::with_capacity(2);
        note.insert("type", Value::from("started"));
        note.insert("processId", Value::from(open.process_id.as_str()));
        core.note(&ace_json::to_string(&Value::Object(note)));
        verify_extension(&inner, &open.launch.extension_path).await?;
        if let Some(resume) = &resume {
            restore(&inner, resume).await?;
        }
        let state = get_state(&inner).await?;
        let reference = SessionReference {
            path: state.session_file.clone(),
            id: state.session_id.clone(),
        };
        let native_id = save_session_reference(&open.reference_dir, &reference)?;
        open.observer.identity(&native_id);
        Ok::<_, PiSessionError>((state, native_id))
    }
    .await;
    match opened {
        Ok((state, native_id)) => Ok(PiSession {
            inner,
            native_id,
            native_file: state.session_file,
            root_key: open.root_key,
            control_secret: open.control_secret,
            model: open.launch.model,
            effort: open.launch.effort,
        }),
        Err(error) => {
            // A child exists here, so its close (or the cutoff) brings Drained after the stop.
            if !inner.closing.load(Ordering::Acquire) {
                inner.deliberate.store(false, Ordering::SeqCst);
                let _ = inner.stop_process().await;
                inner.await_drained().await;
            }
            let close = inner.close(false).await.err();
            if let Some(close) = close {
                inner.note_stop_failed(&close.to_string());
            }
            Err(error)
        }
    }
}

impl PiSession {
    /// The native session file (`PiSession.nativeSessionFile` in the TypeScript).
    pub fn native_session_file(&self) -> &str {
        &self.native_file
    }

    async fn request(&self, command: &str, params: Map) -> Result<String, PiSessionError> {
        self.inner.request(command, &params).await
    }
}

fn config_content(open: &PiSessionOpen) -> String {
    config_content_for(
        &open.control_secret,
        open.lease.as_ref(),
        open.launch.permission_mode.as_deref(),
    )
}

/// `JSON.stringify({controlSecret, mcp?, readOnly?})`, key order included.
fn config_content_for(secret: &str, lease: Option<&PiLease>, mode: Option<&str>) -> String {
    let mut map = Map::with_capacity(3);
    map.insert("controlSecret", Value::String(JsString::from(secret)));
    if let Some(lease) = lease {
        let mut mcp = Map::with_capacity(2);
        mcp.insert("url", Value::String(JsString::from(lease.url.as_str())));
        mcp.insert(
            "bearer",
            Value::String(JsString::from(lease.bearer.as_str())),
        );
        map.insert("mcp", Value::Object(mcp));
    }
    // Read-only keeps `ace_*` in Pi's allowlist; the extension then offers only read tools.
    if mode == Some(super::launch::READ_ONLY) {
        map.insert("readOnly", Value::Bool(true));
    }
    ace_json::to_string(&Value::Object(map))
}

/// `verifyExtension` (`session.ts:172`–`:185`): the extension's own command must be listed.
async fn verify_extension(inner: &Inner, extension_path: &str) -> Result<(), PiSessionError> {
    let data = inner.request("get_commands", &Map::new()).await?;
    let value = ace_json::parse(&data).map_err(|_| PiSessionError::State)?;
    let commands = value
        .get("commands")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let found = commands.iter().any(|command| {
        command.get("name").and_then(Value::as_str) == Some("ace-rollback")
            && command.get("source").and_then(Value::as_str) == Some("extension")
            && command
                .get("sourceInfo")
                .and_then(|info| info.get("path"))
                .and_then(Value::as_str)
                == Some(extension_path)
    });
    if found {
        Ok(())
    } else {
        Err(PiSessionError::Extension)
    }
}

async fn get_state(inner: &Inner) -> Result<PiState, PiSessionError> {
    let data = inner.request("get_state", &Map::new()).await?;
    parse_state(&data)
}

fn parse_state(data: &str) -> Result<PiState, PiSessionError> {
    let value = ace_json::parse(data).map_err(|_| PiSessionError::State)?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Ok(PiState {
        session_file: text("sessionFile").ok_or(PiSessionError::State)?,
        session_id: text("sessionId").ok_or(PiSessionError::State)?,
        is_streaming: value
            .get("isStreaming")
            .and_then(Value::as_bool)
            .ok_or(PiSessionError::State)?,
        is_compacting: value
            .get("isCompacting")
            .and_then(Value::as_bool)
            .ok_or(PiSessionError::State)?,
        pending_message_count: value
            .get("pendingMessageCount")
            .and_then(Value::as_f64)
            .filter(|count| *count >= 0.0 && count.fract() == 0.0)
            .map(|count| count as u64)
            .ok_or(PiSessionError::State)?,
    })
}

/// `restore` (`session.ts:335`–`:345`): load the saved session, then prove Pi kept its identity.
async fn restore(inner: &Inner, reference: &CheckedReference) -> Result<(), PiSessionError> {
    checked_session_reference(&encode_session_reference(&SessionReference {
        path: reference.path.clone(),
        id: reference.id.clone(),
    })?)?;
    let mut params = Map::with_capacity(1);
    params.insert("sessionPath", Value::from(reference.path.as_str()));
    let data = inner.request("switch_session", &params).await?;
    let value = ace_json::parse(&data).map_err(|_| PiSessionError::State)?;
    match value.get("cancelled").and_then(Value::as_bool) {
        Some(false) => {}
        _ => return Err(PiHistoryError::CancelledSwitch.into()),
    }
    let state = get_state(inner).await?;
    if state.session_file != reference.path || state.session_id != reference.id {
        return Err(PiHistoryError::Identity.into());
    }
    checked_session_reference(&encode_session_reference(&SessionReference {
        path: reference.path.clone(),
        id: reference.id.clone(),
    })?)?;
    Ok(())
}

/// The prompt a send writes, with Pi's images after the message (`input.ts:26`).
fn prompt_params(input: &PiInput, streaming: Option<&str>) -> Map {
    let mut params = Map::with_capacity(3);
    params.insert(
        "message",
        Value::String(JsString::from(input.message.as_str())),
    );
    if !input.images.is_empty() {
        params.insert(
            "images",
            Value::Array(
                input
                    .images
                    .iter()
                    .map(|image| {
                        let mut map = Map::with_capacity(3);
                        map.insert("type", Value::from("image"));
                        map.insert("data", Value::String(JsString::from(image.data.as_str())));
                        map.insert(
                            "mimeType",
                            Value::String(JsString::from(image.mime_type.as_str())),
                        );
                        Value::Object(map)
                    })
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
    }
    if let Some(streaming) = streaming {
        params.insert("streamingBehavior", Value::from(streaming));
    }
    params
}

impl Session for PiSession {
    fn native_session_id(&self) -> &str {
        &self.native_id
    }

    fn session_confirmed(&self) -> bool {
        true
    }

    /// Pi takes `--model`, `--thinking` and the access mode at launch only, so a changed
    /// selection is a fresh connection (the engine's `reopen`).
    fn configure(
        &self,
        selection: ExecutionSelection,
    ) -> LocalBoxFuture<'_, Result<Option<Reopen>, AdapterApiError>> {
        let model = selection.model.as_ref().map(|model| model.to_string());
        let effort = selection
            .options
            .get("effort")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let changed = model != self.model || effort != self.effort;
        Box::pin(async move { Ok(changed.then_some(Reopen::Reopen)) })
    }

    fn set_model(&self, _model: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Provider model selection unavailable".to_owned(),
            ))
        })
    }

    fn set_mode(&self, mode: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(format!(
                "Pi cannot run the permission mode {mode}"
            )))
        })
    }

    fn set_goal(&self, _change: GoalChange) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Provider goals unavailable".to_owned(),
            ))
        })
    }

    fn clear_goal(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Provider goals unavailable".to_owned(),
            ))
        })
    }

    fn send(&self, input: SendInput<'_>) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        // Admission runs now, in the caller's synchronous turn, so the future owns every value
        // it needs and the fence is read in one step with the first write being queued.
        let prepared = self.prepare_send(&input);
        Box::pin(async move {
            match prepared {
                Err(error) => Err(error),
                Ok(prepared) => self.write_send(prepared).await,
            }
        })
    }

    fn interrupt(
        &self,
        target: InterruptTarget,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            self.inner.check().map_err(PiSessionError::into_adapter)?;
            if target
                .agent
                .as_ref()
                .is_some_and(|agent| *agent != self.root_key)
            {
                return Err(AdapterApiError::InputRejected(
                    "Pi has no native child interrupt".to_owned(),
                ));
            }
            for command in INTERRUPT_COMMANDS {
                self.request(command, Map::new())
                    .await
                    .map_err(PiSessionError::into_adapter)?;
            }
            Ok(())
        })
    }

    fn resolve(
        &self,
        interaction: ace_core::Key,
        resolution: InteractionResolution,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            self.inner
                .check_open()
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            let key = JsString::from(interaction.as_str());
            let dialog = self.inner.core.peek_dialog(&key).ok_or_else(|| {
                AdapterApiError::InputRejected(PiDialogError::NotPending.to_string())
            })?;
            let value = ace_json::parse(&dialog)
                .map_err(|_| AdapterApiError::InputRejected(PiSessionError::State.to_string()))?;
            // Validate before reserving, so a bad answer leaves the dialog pending.
            let response = dialog_response(&value, &resolution)
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            // Reserve before writing so concurrent devices cannot answer twice.
            if !self.inner.core.take_dialog(&key) {
                return Err(AdapterApiError::InputRejected(
                    PiDialogError::NotPending.to_string(),
                ));
            }
            if let Err(error) = self.inner.write(&response, true).await {
                self.inner.fatal();
                return Err(error.into_adapter());
            }
            Ok(())
        })
    }

    fn stop_task(&self, _task: ace_core::Key) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Pi has no individual native background-task control".to_owned(),
            ))
        })
    }

    fn close(&self, _reason: CloseReason) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            self.inner
                .close(true)
                .await
                .map_err(PiSessionError::into_adapter)
        })
    }
}

/// One send after admission: what the future writes, with nothing borrowed.
enum PreparedSend {
    /// ace's own input, already marked as context.
    Ace(String),
    /// One admission per native command, in order.
    Prompts(Vec<(PiInput, &'static str)>),
}

impl PiSession {
    /// `send` up to the first write (`session.ts:394`–`:415`): the session check, the parts as
    /// raw JSON, `nativeCommandInputs`, `piInput`, and the steer fence before the first prompt.
    fn prepare_send(&self, input: &SendInput<'_>) -> Result<PreparedSend, AdapterApiError> {
        // A closed or busy session refuses before anything is built, as `check()` does.
        self.inner
            .check()
            .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
        let values = content_part_values(input.input)
            .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
        if matches!(input.origin, Some(InputSource::Ace)) {
            let content = pi_input(&values)
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            let encoded = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                content.message.as_bytes(),
            );
            return Ok(PreparedSend::Ace(format!(
                "/ace-context {} {encoded}",
                self.control_secret
            )));
        }
        // Validate every admission before the first one can reach the harness.
        let inputs = native_command_inputs(&values)
            .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
        let streaming = match input.delivery {
            Delivery::Steer => "steer",
            Delivery::Queue => "followUp",
        };
        let mut prepared = Vec::with_capacity(inputs.len());
        for content in inputs {
            let content = pi_input(&content)
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            prepared.push((content, streaming));
        }
        // Before the first prompt only: once one is taken, the rest belong with it.
        assert_steer_target(input.delivery, input.fence)?;
        Ok(PreparedSend::Prompts(prepared))
    }

    async fn write_send(&self, prepared: PreparedSend) -> Result<(), AdapterApiError> {
        match prepared {
            PreparedSend::Ace(message) => self
                .request("prompt", prompt_params_of(message))
                .await
                .map(|_| ())
                .map_err(|error| send_error(error, 0, true)),
            PreparedSend::Prompts(prompts) => {
                let mut accepted = 0_usize;
                for (content, streaming) in prompts {
                    match self
                        .request("prompt", prompt_params(&content, Some(streaming)))
                        .await
                    {
                        Ok(_) => accepted += 1,
                        Err(error) => return Err(send_error(error, accepted, true)),
                    }
                }
                Ok(())
            }
        }
    }
}

/// `send`'s catch (`session.ts:416`–`:423`): a refusal before anything was taken is the
/// provider turning the send down; anything after acceptance may have run.
fn send_error(error: PiSessionError, accepted: usize, requested: bool) -> AdapterApiError {
    if accepted == 0 && (!requested || matches!(error, PiSessionError::Refused(_))) {
        return AdapterApiError::InputRejected(error.to_string());
    }
    error.into_adapter()
}

fn prompt_params_of(message: String) -> Map {
    let mut params = Map::with_capacity(1);
    params.insert("message", Value::from(message.as_str()));
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_private_config_is_written_in_the_typescripts_key_order() {
        let lease = PiLease::new("http://127.0.0.1:1/mcp".to_owned(), "b".repeat(64), || {});
        assert_eq!(
            config_content_for("a", Some(&lease), Some(super::super::launch::READ_ONLY)),
            format!(
                "{{\"controlSecret\":\"a\",\"mcp\":{{\"url\":\"http://127.0.0.1:1/mcp\",\"bearer\":\"{}\"}},\"readOnly\":true}}",
                "b".repeat(64)
            )
        );
        assert_eq!(
            config_content_for("a", None, None),
            "{\"controlSecret\":\"a\"}"
        );
    }

    #[test]
    fn a_state_reply_missing_a_field_is_refused_and_present_ones_are_read() {
        assert_eq!(
            parse_state(
                "{\"sessionFile\":\"/tmp/a.jsonl\",\"sessionId\":\"native\",\"isStreaming\":false,\"isCompacting\":false,\"pendingMessageCount\":0}"
            ),
            Ok(PiState {
                session_file: "/tmp/a.jsonl".to_owned(),
                session_id: "native".to_owned(),
                is_streaming: false,
                is_compacting: false,
                pending_message_count: 0,
            })
        );
        assert_eq!(
            parse_state("{\"sessionFile\":\"/tmp/a.jsonl\"}").unwrap_err(),
            PiSessionError::State
        );
    }
}
