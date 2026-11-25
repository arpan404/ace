// SPDX-License-Identifier: Apache-2.0
//! Test support for the moved (b) cases: they need a real app-server, so they
//! spawn the adapter's own fake (`packages/adapter-codex/src/testing/shared-cli.ts`)
//! with `bun` from `PATH`, through the same diversion a session's child takes
//! (E3.0b). A missing `bun` fails the test, it never skips.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use ace_adapter_api::util::{ElisionLimits, JsonElider};
use ace_json::{JsString, Value};
use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::divert::{ChildPorts, DivertTarget, Diverted, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::lines::LineFramer;
use ace_supervisor::peer::Direction;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use tokio::runtime::Runtime;

use super::app_server::{AppServerConfig, AppServerEffect};
use super::host::{
    Admission, ChannelHandlers, Host, HostConfig, HostEffect, HostExit, HostGate, RequestAnswer,
    Retirement,
};
use super::lease::{Lease, LeaseEffect, UNLOAD_CLOSED_THREADS};

/// The provider line bound (`maxLineBytes`).
pub const LINE_LIMIT: usize = 16 * 1024 * 1024;
/// How long a test waits for a real process to say something.
pub const WAIT_MS: u64 = 10_000;

/// One thing the shell saw, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Frame {
        tenant: u64,
        dir: Direction,
        data: Value,
    },
    Notification {
        tenant: u64,
        method: JsString,
    },
    Request {
        tenant: u64,
        id: RpcId,
        method: JsString,
        params: Option<Value>,
    },
    Dropped {
        tenant: u64,
        bytes: usize,
    },
    Uncertain {
        tenant: u64,
    },
    Malformed {
        tenant: u64,
        line: String,
    },
    Stderr {
        tenant: u64,
        line: String,
    },
    Error {
        tenant: u64,
        message: String,
    },
    AdmissionFailed {
        tenant: u64,
        message: String,
    },
    Exited {
        tenant: u64,
        exit: HostExit,
    },
    Ready {
        tenant: u64,
    },
    OpenFailed {
        tenant: u64,
        message: String,
    },
    Settle {
        id: u64,
        failed: bool,
    },
    Retire {
        reason: Retirement,
        awaited: bool,
    },
    /// The shell's stop did not confirm: the process is still running.
    StopFailed {
        reason: Retirement,
        awaited: bool,
        message: String,
    },
    /// One line a short-lived app-server was sent, verbatim.
    Line {
        text: String,
    },
    Retired,
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    AppReady,
    AppFailed(String),
    Held,
    NotHeld(String),
    LeaseFailed(String),
    Released,
    Wrote {
        bytes: usize,
    },
}

/// Everything the shell and the tenants reported, with a wake-up for the
/// test thread.
#[derive(Default)]
pub struct Events {
    log: Mutex<Vec<Event>>,
    wake: Condvar,
}

impl Events {
    pub fn push(&self, event: Event) {
        self.log.lock().expect("events lock").push(event);
        self.wake.notify_all();
    }

    pub fn snapshot(&self) -> Vec<Event> {
        self.lock().clone()
    }

    /// Waits until one event matches, within `ms`.
    pub fn until(&self, ms: u64, pred: impl Fn(&Event) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        let mut log = self.lock();
        loop {
            if log.iter().any(&pred) {
                return true;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, _) = self.wake.wait_timeout(log, left).expect("events wait");
            log = next;
        }
    }

    /// Waits until the whole log satisfies `pred`, within `ms`.
    pub fn satisfies(&self, ms: u64, pred: impl Fn(&[Event]) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        let mut log = self.lock();
        loop {
            if pred(&log) {
                return true;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, _) = self.wake.wait_timeout(log, left).expect("events wait");
            log = next;
        }
    }

    /// Every received frame one tenant was given, in order.
    pub fn frames(&self, tenant: u64) -> Vec<Value> {
        self.lock()
            .iter()
            .filter_map(|event| match event {
                Event::Frame {
                    tenant: who,
                    dir: Direction::Recv,
                    data,
                } if *who == tenant => Some(data.clone()),
                _ => None,
            })
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Event>> {
        self.log.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// One tenant's channel, recording what the host sent it.
pub struct Recorder {
    tenant: u64,
    events: Arc<Events>,
}

impl Recorder {
    pub fn new(tenant: u64, events: Arc<Events>) -> Arc<Recorder> {
        Arc::new(Recorder { tenant, events })
    }
}

impl ChannelHandlers for Recorder {
    fn frame(&self, dir: Direction, data: &Value) -> Admission {
        self.events.push(Event::Frame {
            tenant: self.tenant,
            dir,
            data: data.clone(),
        });
        Admission::Taken
    }

    fn notification(&self, method: &JsString, _params: Option<&Value>) {
        self.events.push(Event::Notification {
            tenant: self.tenant,
            method: method.clone(),
        });
    }

    fn request(&self, id: &RpcId, method: &JsString, params: Option<&Value>) -> RequestAnswer {
        self.events.push(Event::Request {
            tenant: self.tenant,
            id: id.clone(),
            method: method.clone(),
            params: params.cloned(),
        });
        RequestAnswer::Answered(ace_json::json!({}))
    }

    fn dropped(&self, line: &super::host::DroppedLine) {
        self.events.push(Event::Dropped {
            tenant: self.tenant,
            bytes: line.bytes,
        });
    }

    fn output_uncertain(&self) {
        self.events.push(Event::Uncertain {
            tenant: self.tenant,
        });
    }

    fn malformed(&self, line: &str) {
        self.events.push(Event::Malformed {
            tenant: self.tenant,
            line: line.to_owned(),
        });
    }

    fn stderr(&self, line: &str) {
        self.events.push(Event::Stderr {
            tenant: self.tenant,
            line: line.to_owned(),
        });
    }

    fn error(&self, message: &str) {
        self.events.push(Event::Error {
            tenant: self.tenant,
            message: message.to_owned(),
        });
    }

    fn failed(&self, message: &str) {
        self.events.push(Event::AdmissionFailed {
            tenant: self.tenant,
            message: message.to_owned(),
        });
    }

    fn exited(&self, exit: &HostExit) {
        self.events.push(Event::Exited {
            tenant: self.tenant,
            exit: exit.clone(),
        });
    }

    fn ready(&self) {
        self.events.push(Event::Ready {
            tenant: self.tenant,
        });
    }
}

/// A scratch directory, removed when the test ends.
pub struct Scratch {
    path: PathBuf,
}

impl Scratch {
    pub fn new(name: &str) -> Scratch {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ace-codex-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("scratch dir creates");
        Scratch { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The wrapper the fake app-server is started through, as the adapter's
    /// own tests start it: `bun` runs the TS module.
    pub fn cli(&self) -> PathBuf {
        let cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../packages/adapter-codex/src/testing/shared-cli.ts");
        let wrapper = self.path.join("codex.mjs");
        std::fs::write(
            &wrapper,
            format!(
                "import {};\n",
                ace_json::to_string(&Value::from(cli.to_string_lossy().into_owned()))
            ),
        )
        .expect("fake cli wrapper writes");
        wrapper
    }

    pub fn writers(&self) -> String {
        self.path.join("writers").to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// `bun` from `PATH`; its absence fails the test.
pub fn bun() -> String {
    if let Ok(explicit) = std::env::var("BUN") {
        return explicit;
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for directory in path.split(':') {
        let candidate = Path::new(directory).join("bun");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    panic!("the moved Codex host cases need bun on PATH");
}

/// A child that writes both pipes, with the gate in front of them.
pub struct GateRun {
    pub gate: HostGate,
    seen: Arc<Mutex<Vec<(OutputStream, usize)>>>,
    _root: Scratch,
    runtime: Runtime,
    child: SupervisedChild,
}

struct GateConsumer {
    gate: HostGate,
    seen: Arc<Mutex<Vec<(OutputStream, usize)>>>,
}

impl OutputConsumer for GateConsumer {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.seen
            .lock()
            .expect("gate chunks")
            .push((stream, bytes.len()));
        self.gate.answer(delivered);
    }

    fn end(&self, _stream: OutputStream) {}
    fn stdin_written(&self) {}
    fn stdin_error(&self, _error: NodeIoError) {}
    fn exit(&self, _exit: RawExit) {}
    fn close(&self, _exit: RawExit) {}
}

impl GateRun {
    /// Spawns a probe writing both streams, with the gate in front of them.
    pub fn start(root: Scratch) -> GateRun {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test runtime");
        let script = root.path().join("gate-probe.mjs");
        std::fs::write(
            &script,
            "const line = `${'x'.repeat(262144)}\\n`;\nfor (let i = 0; i < 30; i++) {\n  process.stdout.write(line);\n  process.stderr.write(line);\n  await Bun.sleep(20);\n}\n",
        )
        .expect("the probe writes");
        let gate = HostGate::new();
        let seen: Arc<Mutex<Vec<(OutputStream, usize)>>> = Arc::new(Mutex::new(Vec::new()));
        let consumer = Arc::new(GateConsumer {
            gate: gate.clone(),
            seen: Arc::clone(&seen),
        });
        let mut environment = vec![("PATH".to_owned(), std::env::var("PATH").unwrap_or_default())];
        if let Ok(home) = std::env::var("HOME") {
            environment.push(("HOME".to_owned(), home));
        }
        let ports: Arc<OnceLock<ChildPorts>> = Arc::new(OnceLock::new());
        let child = spawn_child(
            &SpawnSpec {
                command: bun(),
                args: vec![script.to_string_lossy().into_owned()],
                cwd: Some(root.path().to_string_lossy().into_owned()),
                env: environment,
                windows_verbatim: false,
                hide_window: true,
                contain: cfg!(windows),
                max_output_bytes: None,
                stdin: StdioMode::Piped,
                stdout: StdioMode::Piped,
                stderr: StdioMode::Piped,
            },
            Diverted::new(Nothing, Arc::clone(&consumer) as Arc<dyn OutputConsumer>),
            runtime.handle(),
            Some(&DivertTarget {
                consumer: Arc::clone(&consumer) as Arc<dyn OutputConsumer>,
                ports: Arc::clone(&ports),
            }),
        )
        .expect("the probe spawns");
        if let Some(child_ports) = ports.get() {
            gate.attach(child_ports.output.clone());
        }
        GateRun {
            gate,
            seen,
            _root: root,
            runtime,
            child,
        }
    }

    /// How many bytes each pipe delivered and the gate answered, stdout then
    /// stderr.
    pub fn bytes(&self) -> (usize, usize) {
        let seen = self.seen.lock().expect("gate chunks");
        let total = |stream| {
            seen.iter()
                .filter(|(which, _)| *which == stream)
                .map(|(_, bytes)| bytes)
                .sum()
        };
        (total(OutputStream::Stdout), total(OutputStream::Stderr))
    }

    /// Waits until both pipes delivered at least `bytes` bytes.
    pub fn wait_for(&self, bytes: usize) -> bool {
        let deadline = Instant::now() + Duration::from_millis(WAIT_MS);
        while Instant::now() < deadline {
            let (stdout, stderr) = self.bytes();
            if stdout >= bytes && stderr >= bytes {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    pub fn stop(&self) {
        self.child.dispose();
        self.runtime.block_on(async {
            tokio::time::sleep(Duration::from_millis(10)).await;
        });
    }
}

impl Drop for GateRun {
    fn drop(&mut self) {
        self.child.dispose();
    }
}

/// An app-server's process arguments: Codex's own unload override, then the
/// subcommand (`unloadClosedThreads`, `thread-lease.ts:9`).
pub fn codex_args() -> Vec<&'static str> {
    let mut args = UNLOAD_CLOSED_THREADS.to_vec();
    args.push("app-server");
    args
}

/// The spawn spec a bare bun script is started with, in the scratch root.
fn script_spec(root: &Scratch, script: &Path) -> SpawnSpec {
    let mut environment = vec![("PATH".to_owned(), std::env::var("PATH").unwrap_or_default())];
    if let Ok(home) = std::env::var("HOME") {
        environment.push(("HOME".to_owned(), home));
    }
    SpawnSpec {
        command: bun(),
        args: vec![script.to_string_lossy().into_owned()],
        cwd: Some(root.path().to_string_lossy().into_owned()),
        env: environment,
        windows_verbatim: false,
        hide_window: true,
        contain: cfg!(windows),
        max_output_bytes: None,
        stdin: StdioMode::Piped,
        stdout: StdioMode::Piped,
        stderr: StdioMode::Piped,
    }
}

/// The spawn spec the fake app-server is started with.
fn spec(root: &Scratch, args: &[&str], writers: Option<&str>) -> SpawnSpec {
    let mut environment = vec![("PATH".to_owned(), std::env::var("PATH").unwrap_or_default())];
    if let Ok(home) = std::env::var("HOME") {
        environment.push(("HOME".to_owned(), home));
    }
    if let Some(writers) = writers {
        environment.push(("ACE_FAKE_CODEX_WRITER_ROOT".to_owned(), writers.to_owned()));
    }
    let mut all = vec![root.cli().to_string_lossy().into_owned()];
    all.extend(args.iter().map(|arg| (*arg).to_owned()));
    SpawnSpec {
        command: bun(),
        args: all,
        cwd: Some(root.path().to_string_lossy().into_owned()),
        env: environment,
        windows_verbatim: false,
        hide_window: true,
        contain: cfg!(windows),
        max_output_bytes: None,
        stdin: StdioMode::Piped,
        stdout: StdioMode::Piped,
        stderr: StdioMode::Piped,
    }
}

/// The shell's own sink: the fake's streams are the session's only.
#[derive(Clone)]
struct Nothing;

impl EventSink for Nothing {
    fn output(&self, _stream: OutputStream, _bytes: Vec<u8>, _delivered: Delivered) {}
    fn end(&self, _stream: OutputStream) {}
    fn exit(&self, _exit: RawExit) {}
    fn close(&self, _exit: RawExit) {}
    fn stdin_written(&self) {}
    fn stdin_error(&self, _error: NodeIoError) {}
    fn hold_limit(&self) {}
    fn held(&self, _message: String) {}
}

/// One framed stdout stream, with its elider.
struct Framing {
    elider: JsonElider,
    framer: LineFramer,
}

impl Framing {
    fn new(elision: ElisionLimits) -> Framing {
        Framing {
            elider: JsonElider::new(elision).expect("elision limits"),
            framer: LineFramer::new(LINE_LIMIT),
        }
    }

    fn lines(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut elided = Vec::with_capacity(bytes.len());
        self.elider.push(bytes, &mut elided);
        match self.framer.push(&elided) {
            Ok(lines) if lines.count > 0 => lines.text.split('\n').map(str::to_owned).collect(),
            _ => Vec::new(),
        }
    }
}

/// The host's shell: bytes in, the peer's lines and effects out.
struct HostConsumer {
    host: Arc<Host>,
    events: Arc<Events>,
    ports: Arc<OnceLock<ChildPorts>>,
    active: Arc<Mutex<Option<u64>>>,
    handlers: Arc<Mutex<HashMap<u64, Arc<Recorder>>>>,
    /// What the shell does when the host asks for the child to stop.
    stop: Arc<dyn Fn(Retirement, bool) -> Result<(), String> + Send + Sync>,
    /// The stop in flight's failure, which a later caller joins.
    stop_failure: Arc<Mutex<Option<String>>>,
    stdout: Mutex<Framing>,
    stderr: Mutex<LineFramer>,
}

impl HostConsumer {
    fn apply(&self, effects: Vec<HostEffect>) {
        for effect in effects {
            match effect {
                HostEffect::Write { wire, ticket } => {
                    *self.active.lock().expect("active write") = Some(ticket);
                    self.events.push(Event::Wrote { bytes: wire.len() });
                    if let Ok(text) = std::str::from_utf8(&wire) {
                        self.events.push(Event::Line {
                            text: text.trim_end().to_owned(),
                        });
                    }
                    if let Some(ports) = self.ports.get() {
                        let _ = ports.stdin.write(wire);
                    }
                }
                HostEffect::ArmTimer { key, ms } => {
                    self.events.push(Event::ArmTimer { key, ms });
                }
                HostEffect::CancelTimer { key } => {
                    self.events.push(Event::CancelTimer { key });
                }
                HostEffect::Settle { id, result } => self.events.push(Event::Settle {
                    id,
                    failed: result.is_err(),
                }),
                HostEffect::Retire { reason, awaited } => {
                    self.events.push(Event::Retire { reason, awaited });
                    if let Err(message) = (self.stop)(reason, awaited) {
                        // The shell holds the stop: its failure reaches every
                        // caller that joins it, and a host that survives takes
                        // backpressure again.
                        *self.stop_failure.lock().expect("stop failure") = Some(message.clone());
                        self.host.stop_failed();
                        self.events.push(Event::StopFailed {
                            reason,
                            awaited,
                            message,
                        });
                    }
                }
                HostEffect::Retiring { reason } => {
                    let failure = self.stop_failure.lock().expect("stop failure").clone();
                    if let Some(message) = failure {
                        self.events.push(Event::StopFailed {
                            reason,
                            awaited: true,
                            message,
                        });
                    }
                }
                HostEffect::Exited { tenant, exit } => {
                    if let Some(handlers) =
                        self.handlers.lock().expect("tenant handlers").get(&tenant)
                    {
                        handlers.exited(&exit);
                    }
                }
                HostEffect::Retired => self.events.push(Event::Retired),
                HostEffect::Opened { tenant } => self.events.push(Event::Ready { tenant }),
                HostEffect::OpenFailed { tenant, message } => {
                    self.events.push(Event::OpenFailed { tenant, message });
                }
            }
        }
    }
}

impl OutputConsumer for HostConsumer {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        match stream {
            OutputStream::Stdout => {
                let lines = self.stdout.lock().expect("stdout framing").lines(&bytes);
                for line in lines {
                    let effects = self.host.line(&line);
                    self.apply(effects);
                }
            }
            OutputStream::Stderr => {
                let mut framer = self.stderr.lock().expect("stderr framing");
                if let Ok(lines) = framer.push(&bytes)
                    && lines.count > 0
                {
                    for line in lines.text.split('\n') {
                        self.host.stderr_line(line);
                    }
                }
            }
        }
        self.host.answer_delivery(delivered);
    }

    fn end(&self, _stream: OutputStream) {}

    fn stdin_written(&self) {
        let ticket = self.active.lock().expect("active write").take();
        if let Some(ticket) = ticket {
            let effects = self.host.written(ticket);
            self.apply(effects);
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.events.push(Event::AppFailed(format!("{error:?}")));
    }

    fn exit(&self, exit: RawExit) {
        let effects = self.host.exit(exit);
        self.apply(effects);
    }

    fn close(&self, exit: RawExit) {
        let effects = self.host.closed(exit);
        self.apply(effects);
    }
}

/// What a host's shell does when the host asks it to stop the child.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// Ends stdin and lets the child exit, as a real stop does.
    Ends,
    /// The stop could not be confirmed: the process outlives it.
    Fails,
}

/// One host over a real app-server, and its child.
pub struct HostRun {
    pub host: Arc<Host>,
    pub events: Arc<Events>,
    handlers: Arc<Mutex<HashMap<u64, Arc<Recorder>>>>,
    _root: Scratch,
    runtime: Runtime,
    ports: Arc<OnceLock<ChildPorts>>,
    consumer: Arc<HostConsumer>,
    child: SupervisedChild,
    next_id: AtomicU64,
}

impl HostRun {
    /// Spawns the fake and starts the host's handshake.
    pub fn start(
        root: Scratch,
        config: HostConfig,
        elision: ElisionLimits,
        writers: Option<&str>,
    ) -> HostRun {
        HostRun::start_with(root, config, elision, writers, Stop::Ends)
    }

    /// A host whose stop policy the test decides: a stop the shell cannot
    /// confirm is the Windows tree that outlived its stop.
    pub fn start_with(
        root: Scratch,
        config: HostConfig,
        elision: ElisionLimits,
        writers: Option<&str>,
        stop: Stop,
    ) -> HostRun {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test runtime");
        let events = Arc::new(Events::default());
        let ports: Arc<OnceLock<ChildPorts>> = Arc::new(OnceLock::new());
        let active = Arc::new(Mutex::new(None));
        let (host, initial) = Host::new(config);
        let host = Arc::new(host);
        let handlers: Arc<Mutex<HashMap<u64, Arc<Recorder>>>> = Arc::default();
        let policy: Arc<dyn Fn(Retirement, bool) -> Result<(), String> + Send + Sync> = match stop {
            Stop::Ends => {
                let ports = Arc::clone(&ports);
                Arc::new(move |_, _| {
                    if let Some(ports) = ports.get() {
                        ports.stdin.end();
                    }
                    Ok(())
                })
            }
            Stop::Fails => Arc::new(|_, _| Err("the process tree outlived its stop".to_owned())),
        };
        let consumer = Arc::new(HostConsumer {
            host: Arc::clone(&host),
            events: Arc::clone(&events),
            ports: Arc::clone(&ports),
            active,
            handlers: Arc::clone(&handlers),
            stop: policy,
            stop_failure: Arc::new(Mutex::new(None)),
            stdout: Mutex::new(Framing::new(elision)),
            stderr: Mutex::new(LineFramer::new(LINE_LIMIT)),
        });
        let child = spawn_child(
            &spec(&root, &codex_args(), writers),
            Diverted::new(Nothing, Arc::clone(&consumer) as Arc<dyn OutputConsumer>),
            runtime.handle(),
            Some(&DivertTarget {
                consumer: Arc::clone(&consumer) as Arc<dyn OutputConsumer>,
                ports: Arc::clone(&ports),
            }),
        )
        .expect("the fake app-server spawns");
        host.set_pid(child.pid());
        if let Some(child_ports) = ports.get() {
            host.gate().attach(child_ports.output.clone());
        }
        consumer.apply(initial);
        HostRun {
            host,
            events,
            handlers,
            _root: root,
            runtime,
            ports,
            consumer,
            child,
            next_id: AtomicU64::new(1),
        }
    }

    /// A channel on this host, waiting for its open to resolve.
    pub fn attach(&self, tenant: u64) -> Arc<Recorder> {
        self.attach_with(tenant, Recorder::new(tenant, Arc::clone(&self.events)))
    }

    pub fn attach_with(&self, tenant: u64, handlers: Arc<Recorder>) -> Arc<Recorder> {
        self.handlers
            .lock()
            .expect("tenant handlers")
            .insert(tenant, Arc::clone(&handlers));
        let effects = self
            .host
            .attach(tenant, handlers.clone() as Arc<dyn ChannelHandlers>)
            .expect("the host accepts a channel");
        self.apply(effects);
        handlers
    }

    /// Apply effects the test drove the host into, as the shell would.
    pub fn apply(&self, effects: Vec<HostEffect>) {
        self.consumer.apply(effects);
    }

    /// One request from a tenant, with a fresh facade id.
    pub fn request(&self, tenant: u64, method: &str, params: &Value) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let effects = self
            .host
            .request(
                tenant,
                method,
                Some(params),
                id,
                ace_supervisor::peer::Timeout::Default,
            )
            .expect("the host queues the request");
        self.apply(effects);
        id
    }

    pub fn wait_ready(&self, tenant: u64) -> bool {
        self.events.until(
            WAIT_MS,
            |event| matches!(event, Event::Ready { tenant: who } if *who == tenant),
        )
    }

    pub fn wait_exit(&self, tenant: u64) -> bool {
        self.events.until(
            WAIT_MS,
            |event| matches!(event, Event::Exited { tenant: who, .. } if *who == tenant),
        )
    }

    pub fn frames(&self, tenant: u64) -> Vec<Value> {
        self.events.frames(tenant)
    }

    /// Ends stdin and waits for the pipes to close, so no process outlives
    /// the test.
    pub fn stop(&self) {
        if let Some(ports) = self.ports.get() {
            ports.stdin.end();
        }
        let _ = self
            .events
            .until(WAIT_MS, |event| matches!(event, Event::Exited { .. }));
        self.child.dispose();
        self.runtime.block_on(async {
            tokio::time::sleep(Duration::from_millis(10)).await;
        });
    }
}

impl Drop for HostRun {
    fn drop(&mut self) {
        self.child.dispose();
    }
}

/// Wait for a lease's outcome.
pub fn lease_outcome(events: &Events) -> Option<Event> {
    events.snapshot().into_iter().find(|event| {
        matches!(
            event,
            Event::Held | Event::NotHeld(_) | Event::LeaseFailed(_)
        )
    })
}

/// The initialized `initialize` params a lease sends.
pub fn lease_config() -> AppServerConfig {
    AppServerConfig::new(ace_json::json!({
        "clientInfo": {"name": "ace_usage", "title": "ace usage", "version": "0.0.0"},
        "capabilities": {"experimentalApi": true},
    }))
}

/// The lease's effects, flattened for its shell.
pub struct LeaseRun {
    pub lease: Arc<Mutex<Lease>>,
    pub events: Arc<Events>,
    _root: Scratch,
    runtime: Runtime,
    _ports: Arc<OnceLock<ChildPorts>>,
    consumer: Arc<LeaseConsumer>,
    child: SupervisedChild,
}

impl LeaseRun {
    pub fn start(
        root: Scratch,
        config: AppServerConfig,
        thread_id: JsString,
        attempts: usize,
        writers: Option<&str>,
    ) -> LeaseRun {
        LeaseRun::launch(root, config, thread_id, attempts, writers, None)
    }

    /// A lease whose app-server is `source`, a bun script: used to refuse the
    /// handshake, which the fake app-server never does.
    pub fn start_script(
        root: Scratch,
        config: AppServerConfig,
        thread_id: JsString,
        attempts: usize,
        source: &str,
    ) -> LeaseRun {
        LeaseRun::launch(root, config, thread_id, attempts, None, Some(source))
    }

    fn launch(
        root: Scratch,
        config: AppServerConfig,
        thread_id: JsString,
        attempts: usize,
        writers: Option<&str>,
        script: Option<&str>,
    ) -> LeaseRun {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test runtime");
        let events = Arc::new(Events::default());
        let ports = Arc::new(OnceLock::new());
        let active = Arc::new(Mutex::new(None));
        let (lease, initial) = Lease::open(config, thread_id, Some(attempts));
        let lease = Arc::new(Mutex::new(lease));
        let consumer = Arc::new(LeaseConsumer {
            lease: Arc::clone(&lease),
            events: Arc::clone(&events),
            ports: Arc::clone(&ports),
            active,
            framing: Mutex::new(Framing::new(super::pool::CODEX_ELISION)),
        });
        let spawn_spec = match script {
            Some(source) => {
                let path = root.path().join("lease-probe.mjs");
                std::fs::write(&path, source).expect("the probe writes");
                script_spec(&root, &path)
            }
            None => spec(&root, &codex_args(), writers),
        };
        let child = spawn_child(
            &spawn_spec,
            Diverted::new(Nothing, Arc::clone(&consumer) as Arc<dyn OutputConsumer>),
            runtime.handle(),
            Some(&DivertTarget {
                consumer: Arc::clone(&consumer) as Arc<dyn OutputConsumer>,
                ports: Arc::clone(&ports),
            }),
        )
        .expect("the app-server spawns");
        consumer.apply(initial);
        LeaseRun {
            lease,
            events,
            _root: root,
            runtime,
            _ports: ports,
            consumer,
            child,
        }
    }

    pub fn outcome(&self) -> Option<Event> {
        lease_outcome(&self.events)
    }

    pub fn wait_outcome(&self) -> bool {
        self.events.until(WAIT_MS, |event| {
            matches!(
                event,
                Event::Held | Event::NotHeld(_) | Event::LeaseFailed(_)
            )
        })
    }

    pub fn release(&self) {
        let effects = self.lease.lock().expect("lease").release();
        self.consumer.apply(effects);
    }

    pub fn stop(&self) {
        self.child.dispose();
        self.runtime.block_on(async {
            tokio::time::sleep(Duration::from_millis(10)).await;
        });
    }
}

impl Drop for LeaseRun {
    fn drop(&mut self) {
        self.child.dispose();
    }
}

pub struct LeaseConsumer {
    lease: Arc<Mutex<Lease>>,
    events: Arc<Events>,
    ports: Arc<OnceLock<ChildPorts>>,
    active: Arc<Mutex<Option<u64>>>,
    framing: Mutex<Framing>,
}

impl LeaseConsumer {
    fn apply(&self, effects: Vec<LeaseEffect>) {
        for effect in effects {
            match effect {
                LeaseEffect::Server(AppServerEffect::Write { wire, ticket }) => {
                    *self.active.lock().expect("active write") = Some(ticket);
                    self.events.push(Event::Wrote { bytes: wire.len() });
                    if let Ok(text) = std::str::from_utf8(&wire) {
                        self.events.push(Event::Line {
                            text: text.trim_end().to_owned(),
                        });
                    }
                    if let Some(ports) = self.ports.get() {
                        let _ = ports.stdin.write(wire);
                    }
                }
                LeaseEffect::Server(AppServerEffect::ArmTimer { key, ms }) => {
                    // The shell's clock delivers the lease's own retry back
                    // at once; the peer's request deadlines only arm.
                    if key == super::lease::RETRY_TIMER {
                        let effects = self.lease.lock().expect("lease").timer(&key);
                        self.apply(effects);
                    }
                    self.events.push(Event::ArmTimer { key, ms });
                }
                LeaseEffect::Server(AppServerEffect::CancelTimer { key }) => {
                    self.events.push(Event::CancelTimer { key });
                }
                LeaseEffect::Server(AppServerEffect::Ready) => {
                    self.events.push(Event::AppReady);
                }
                LeaseEffect::Server(AppServerEffect::Failed(message)) => {
                    self.events.push(Event::AppFailed(message));
                }
                LeaseEffect::Server(AppServerEffect::Close) => {
                    if let Some(ports) = self.ports.get() {
                        ports.stdin.end();
                    }
                }
                LeaseEffect::Server(AppServerEffect::Settle { id, result }) => {
                    self.events.push(Event::Settle {
                        id,
                        failed: result.is_err(),
                    });
                }
                LeaseEffect::Held => self.events.push(Event::Held),
                LeaseEffect::NotHeld(message) => self.events.push(Event::NotHeld(message)),
                LeaseEffect::Failed(message) => self.events.push(Event::LeaseFailed(message)),
                LeaseEffect::Released => self.events.push(Event::Released),
            }
        }
    }
}

impl OutputConsumer for LeaseConsumer {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        if stream == OutputStream::Stdout {
            let lines = self.framing.lock().expect("framing").lines(&bytes);
            for line in lines {
                let effects = self.lease.lock().expect("lease").line(&line);
                self.apply(effects);
            }
        }
        delivered.taken(true);
    }

    fn end(&self, _stream: OutputStream) {}

    fn stdin_written(&self) {
        let ticket = self.active.lock().expect("active write").take();
        if let Some(ticket) = ticket {
            let effects = self.lease.lock().expect("lease").written(ticket);
            self.apply(effects);
        }
    }

    fn stdin_error(&self, _error: NodeIoError) {}
    fn exit(&self, _exit: RawExit) {}
    fn close(&self, _exit: RawExit) {}
}
