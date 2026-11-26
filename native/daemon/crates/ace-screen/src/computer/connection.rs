// SPDX-License-Identifier: Apache-2.0

//! One `ace-screen-helper --computer` process and its queue (`computer/helper-connection.ts`):
//! requests run one at a time, a `cancel` goes straight to the helper, and a cancelled or
//! overdue request gets a grace period to reply before its helper is stopped. Two helpers for
//! one app never run at once, so a stopping helper's input or clipboard clean-up can't land on
//! top of its replacement's work.
//!
//! One task owns the state; commands arrive on a channel (a request, a child event, a timer, a
//! dispatch's answer) and are applied in order, as the TypeScript's event loop applies them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ace_json::{Map, Value};
use ace_supervisor::signal::SignalName;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::reply_lines::{ReplyLine, ReplyLines};
use super::timing::{Clock, Outcome, RequestSpan, RequestTiming};
use super::wire::{Reply, decode_reply};
use crate::error::ComputerError;

/// The future a helper start resolves to. `'static`, so the connection can await it in its own
/// task while the pool's start lives as long as it likes.
pub type StartFuture =
    Pin<Box<dyn Future<Output = Result<Box<dyn HelperProcess>, ComputerError>> + Send + 'static>>;

/// What a spawned helper reports back, into its connection.
pub trait ChildEvents: Send + Sync {
    /// A chunk of the helper's stdout.
    fn output(&self, bytes: Vec<u8>);
    /// The helper's leader exited.
    fn exit(&self);
    /// A write to the helper's stdin failed.
    fn stdin_error(&self);
}

/// One running helper, as the connection drives it.
pub trait HelperProcess: Send + Sync {
    /// The helper's process id (`helper-connection.ts:142`).
    fn pid(&self) -> u32;
    /// Queues one line for its stdin.
    fn write(&self, bytes: Vec<u8>);
    /// Closes its stdin.
    fn end_stdin(&self);
    /// Sends a signal; `false` when the OS refused it (a helper that outlived SIGKILL).
    fn kill(&self, signal: SignalName) -> bool;
}

/// Starts a helper: the pool's own start (it may wait for a retired helper first), or a test's.
pub trait HelperStart: Send + Sync {
    fn start(&self, events: Arc<dyn ChildEvents>) -> StartFuture;
}

/// Checks at native dispatch; waiting releases this connection's queue slot
/// (`helper-connection.ts:37`).
pub trait Dispatch: Send + Sync {
    /// Whether the request may go now (`helper-connection.ts:233`).
    fn ready(&self) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + '_>>;
    /// The final authority check, synchronous, right before stdin (`:235`).
    fn authorize(&self) -> bool;
    /// Waits for the request's turn again (`:263`).
    fn wait(
        &self,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;
}

/// Everything one connection needs (`helper-connection.ts:16`).
pub struct ConnectionOptions {
    pub start: Arc<dyn HelperStart>,
    pub next_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub now: Clock,
    pub max_reply_bytes: usize,
    /// How long a cancelled or overdue request may take to reply before its helper is killed.
    pub grace_ms: u64,
    /// Windows: how long a helper may take to exit after stdin closes before it is killed.
    pub stop_grace_ms: u64,
    /// How long a stopping helper may take to exit after SIGTERM before it is force-killed.
    pub force_kill_ms: u64,
    /// Called when nothing is queued or running any more, and when work arrives again.
    pub idle: Arc<dyn Fn(bool) + Send + Sync>,
    /// The app this connection serves, for a timing report (`client.ts:197`).
    pub app: Option<String>,
    pub timing: Option<Arc<dyn Fn(RequestTiming) + Send + Sync>>,
}

impl ConnectionOptions {
    /// The two things a connection cannot invent: how to start a helper, and the id generator
    /// every line carries (`helper-connection.ts:20`, `:18`). Never defaulted: two lines that
    /// share an id let a cancel's acknowledgment answer the action it cancelled.
    pub fn new(
        start: Arc<dyn HelperStart>,
        next_id: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> ConnectionOptions {
        ConnectionOptions {
            start,
            next_id,
            now: Arc::new(|| 0.0),
            max_reply_bytes: 32 * 1024 * 1024,
            grace_ms: 3_000,
            stop_grace_ms: 0,
            force_kill_ms: 3_000,
            idle: Arc::new(|_| {}),
            app: None,
            timing: None,
        }
    }
}

/// Why a request is being stopped, for the error it ends with (`helper-connection.ts:54`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    Cancelled,
    Timeout,
}

struct Job {
    /// The id the helper's reply carries.
    id: String,
    op: String,
    line: Vec<u8>,
    deadline_ms: u64,
    cancel: Option<CancellationToken>,
    dispatch: Option<Arc<dyn Dispatch>>,
    /// The helper this request was written to; only its exit fails the request.
    child: Option<u64>,
    ending: Option<Ending>,
    timing: Option<RequestSpan>,
    /// The token a parked request's wait is aborted by (`helper-connection.ts:261`).
    wait_token: Option<CancellationToken>,
    end: oneshot::Sender<Result<Value, ComputerError>>,
}

struct ChildHandle {
    seq: u64,
    process: Box<dyn HelperProcess>,
    /// The child's stdout split into lines: a chunk may end mid-line, and the rest waits here.
    lines: ReplyLines,
}

/// A helper being taken out of service; it stays owned until it has exited.
struct Stopping {
    seq: u64,
    terminated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopStep {
    /// Windows' stop grace elapsed: ask the helper to stop.
    Terminate,
    /// The helper may be force-killed now.
    Force,
    /// A SIGKILL the kernel took: bound the wait for the exit report.
    ForceBound,
}

enum Cmd {
    Begin(Box<Job>),
    Cancel {
        key: u64,
        why: Ending,
    },
    Deadline {
        key: u64,
    },
    Grace {
        key: u64,
    },
    StopStep {
        seq: u64,
        step: StopStep,
    },
    Output {
        child: u64,
        bytes: Vec<u8>,
    },
    Exit {
        child: u64,
    },
    StdinError {
        child: u64,
    },
    Started {
        seq: u64,
        result: Result<Box<dyn HelperProcess>, ComputerError>,
    },
    DispatchReady {
        key: u64,
        ready: Result<bool, String>,
    },
    DispatchWoke {
        key: u64,
        woken: Result<(), String>,
    },
    Pid(oneshot::Sender<Option<u32>>),
    Stopped(oneshot::Sender<Result<(), ComputerError>>),
    Gone(oneshot::Sender<()>),
    Busy(oneshot::Sender<bool>),
    Close,
}

/// One connection's public handle (`HelperConnection`).
#[derive(Clone)]
pub struct Connection {
    shared: Arc<Shared>,
}

impl PartialEq for Connection {
    /// Two handles are one connection exactly when they share it.
    fn eq(&self, other: &Connection) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }
}

struct Shared {
    next_id: Arc<dyn Fn() -> String + Send + Sync>,
    tx: mpsc::UnboundedSender<Cmd>,
    closed: AtomicBool,
}

impl Connection {
    /// Start the connection's task; nothing spawns until a request needs a helper.
    pub fn start(options: ConnectionOptions) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            next_id: Arc::clone(&options.next_id),
            tx: tx.clone(),
            closed: AtomicBool::new(false),
        });
        let state = State::new(options, Arc::clone(&shared));
        tokio::spawn(state.run(rx));
        Self { shared }
    }

    /// One request (`helper-connection.ts:145`); the deadline runs from this call.
    pub async fn request(
        &self,
        op: &str,
        payload: &Map,
        deadline_ms: u64,
        cancel: Option<CancellationToken>,
        dispatch: Option<Arc<dyn Dispatch>>,
    ) -> Result<Value, ComputerError> {
        if self.shared.closed.load(Ordering::Relaxed) {
            return Err(ComputerError::stopped());
        }
        // An abort that already happened fires no `abort` event, so it is honoured here: the
        // request is never queued or written (`helper-connection.ts:153`-`:155`).
        if cancel.as_ref().is_some_and(|token| token.is_cancelled()) {
            return Err(ComputerError::cancelled());
        }
        let (end, finished) = oneshot::channel();
        let job = self.build_job(op, payload, deadline_ms, cancel, dispatch, end);
        if self.shared.tx.send(Cmd::Begin(Box::new(job))).is_err() {
            return Err(ComputerError::stopped());
        }
        match finished.await {
            Ok(result) => result,
            // The connection's task ended (the process is going away).
            Err(_) => Err(ComputerError::stopped()),
        }
    }

    fn build_job(
        &self,
        op: &str,
        payload: &Map,
        deadline_ms: u64,
        cancel: Option<CancellationToken>,
        dispatch: Option<Arc<dyn Dispatch>>,
        end: oneshot::Sender<Result<Value, ComputerError>>,
    ) -> Job {
        let id = (self.shared.next_id)();
        // `{ ...payload, op, id }`: the request's own fields first, then `op` and `id`.
        let mut line = Map::with_capacity(payload.len() + 2);
        for (key, value) in payload {
            line.insert(key.clone(), value.clone());
        }
        line.insert("op".to_owned(), Value::from(op));
        line.insert("id".to_owned(), Value::from(id.as_str()));
        let mut bytes = Value::Object(line).to_json().into_bytes();
        bytes.push(b'\n');
        Job {
            id,
            op: op.to_owned(),
            line: bytes,
            deadline_ms,
            cancel,
            dispatch,
            child: None,
            ending: None,
            timing: None,
            wait_token: None,
            end,
        }
    }

    /// The helper's process id, starting the helper if none is running
    /// (`helper-connection.ts:139`).
    pub async fn pid(&self) -> Option<u32> {
        if self.shared.closed.load(Ordering::Relaxed) {
            return None;
        }
        let (reply, answer) = oneshot::channel();
        if self.shared.tx.send(Cmd::Pid(reply)).is_err() {
            return None;
        }
        answer.await.ok().flatten()
    }

    /// Whether this connection was closed (`helper-connection.ts:135`).
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Relaxed)
    }

    /// Running or waiting requests (`helper-connection.ts:92`).
    pub async fn busy(&self) -> bool {
        let (reply, answer) = oneshot::channel();
        if self.shared.tx.send(Cmd::Busy(reply)).is_err() {
            return false;
        }
        answer.await.unwrap_or(false)
    }

    /// Resolves once no helper is starting, running or stopping; a helper that refuses SIGKILL
    /// fails it at once with `helper_stopping` (`helper-connection.ts:101`).
    pub async fn stopped(&self) -> Result<(), ComputerError> {
        let (reply, answer) = oneshot::channel();
        if self.shared.tx.send(Cmd::Stopped(reply)).is_err() {
            // The task ends only once shutdown found nothing starting, running or stopping, so
            // a retired connection whose helper has exited answers `Ok` here. A successor
            // waiting for it must be able to start, not inherit a closed connection
            // (`helper-connection.ts:101`-`:107`).
            return Ok(());
        }
        match answer.await {
            Ok(result) => result,
            Err(_) => Ok(()),
        }
    }

    /// Resolves once no helper is left, however long that takes (`helper-connection.ts:113`).
    pub async fn gone(&self) {
        let (reply, answer) = oneshot::channel();
        if self.shared.tx.send(Cmd::Gone(reply)).is_ok() {
            let _ = answer.await;
        }
    }

    /// Kills the helper and fails everything queued or running (`helper-connection.ts:186`).
    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::Relaxed);
        let _ = self.shared.tx.send(Cmd::Close);
    }
}

struct State {
    options: ConnectionOptions,
    shared: Arc<Shared>,
    queue: VecDeque<u64>,
    current: Option<u64>,
    parked: HashSet<u64>,
    jobs: HashMap<u64, Job>,
    next_job: u64,
    child: Option<ChildHandle>,
    next_child: u64,
    /// The helper a start in flight will produce; `stopped`/`gone` wait for it.
    starting: Option<u64>,
    /// Helpers whose exit arrived before their start was reported (`helper-connection.ts:244`):
    /// the actor never installs one of these, so a helper that dies at once fails its request
    /// instead of waiting out the deadline.
    exited_while_starting: HashSet<u64>,
    stopping: Option<Stopping>,
    /// The stopping helper refused SIGKILL and still runs: no successor may start.
    unkillable: bool,
    stopped_waiters: Vec<oneshot::Sender<Result<(), ComputerError>>>,
    gone_waiters: Vec<oneshot::Sender<()>>,
    pid_waiters: Vec<oneshot::Sender<Option<u32>>>,
    shutdown: bool,
    idle: bool,
}

impl State {
    fn new(options: ConnectionOptions, shared: Arc<Shared>) -> Self {
        Self {
            options,
            shared,
            queue: VecDeque::new(),
            current: None,
            parked: HashSet::new(),
            jobs: HashMap::new(),
            next_job: 1,
            child: None,
            next_child: 1,
            starting: None,
            exited_while_starting: HashSet::new(),
            stopping: None,
            unkillable: false,
            stopped_waiters: Vec::new(),
            gone_waiters: Vec::new(),
            pid_waiters: Vec::new(),
            shutdown: false,
            idle: true,
        }
    }

    fn closed(&self) -> bool {
        self.shared.closed.load(Ordering::Relaxed)
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        while let Some(command) = rx.recv().await {
            self.apply(command);
            self.settle_waiters();
            self.idle_changed();
            if self.shutdown
                && self.jobs.is_empty()
                && self.starting.is_none()
                && self.stopping.is_none()
            {
                break;
            }
        }
    }

    fn apply(&mut self, command: Cmd) {
        match command {
            Cmd::Begin(job) => self.begin(*job),
            Cmd::Cancel { key, why } => self.cancel(key, why),
            Cmd::Deadline { key } => self.cancel(key, Ending::Timeout),
            Cmd::Grace { key } => self.grace(key),
            Cmd::StopStep { seq, step } => self.stop_step(seq, step),
            Cmd::Output { child, bytes } => self.output(child, &bytes),
            Cmd::Exit { child } => self.exit(child),
            Cmd::StdinError { child } => self.stdin_error(child),
            Cmd::Started { seq, result } => self.started(seq, result),
            Cmd::DispatchReady { key, ready } => self.dispatch_ready(key, ready),
            Cmd::DispatchWoke { key, woken } => self.dispatch_woke(key, woken),
            Cmd::Pid(reply) => self.pid(reply),
            Cmd::Stopped(reply) => self.wait_stopped(reply),
            Cmd::Gone(reply) => self.wait_gone(reply),
            Cmd::Busy(reply) => {
                let _ = reply.send(self.busy());
            }
            Cmd::Close => self.close(),
        }
    }

    fn busy(&self) -> bool {
        self.current.is_some() || !self.queue.is_empty() || !self.parked.is_empty()
    }

    fn begin(&mut self, mut job: Job) {
        if self.closed() {
            let _ = job.end.send(Err(ComputerError::stopped()));
            return;
        }
        if self.options.timing.is_some() {
            job.timing = Some(RequestSpan::new(
                job.op.clone(),
                Arc::clone(&self.options.now),
            ));
        }
        let key = self.next_job;
        self.next_job += 1;
        if let Some(cancel) = job.cancel.clone() {
            let tx = self.shared.tx.clone();
            tokio::spawn(async move {
                cancel.cancelled().await;
                let _ = tx.send(Cmd::Cancel {
                    key,
                    why: Ending::Cancelled,
                });
            });
        }
        let deadline_ms = job.deadline_ms;
        let tx = self.shared.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(deadline_ms)).await;
            let _ = tx.send(Cmd::Deadline { key });
        });
        self.jobs.insert(key, job);
        self.queue.push_back(key);
        self.pump();
    }

    /// Report a finished request's diagnostics; never changes the request's result.
    fn report(&self, job: &mut Job, outcome: Outcome) {
        let Some(report) = &self.options.timing else {
            return;
        };
        let Some(span) = job.timing.take() else {
            return;
        };
        let timing = span.finish(outcome, self.options.app.clone());
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| report(timing)));
    }

    /// End one request with an error.
    fn settle(&mut self, key: u64, error: ComputerError) {
        let Some(mut job) = self.jobs.remove(&key) else {
            return;
        };
        let outcome = match job.ending {
            Some(Ending::Timeout) => Outcome::Timeout,
            Some(Ending::Cancelled) => Outcome::Cancelled,
            None => Outcome::Error,
        };
        self.report(&mut job, outcome);
        let _ = job.end.send(Err(error));
    }

    /// End one request with its result.
    fn resolve(&mut self, key: u64, value: Value) {
        let Some(mut job) = self.jobs.remove(&key) else {
            return;
        };
        self.report(&mut job, Outcome::Ok);
        let _ = job.end.send(Ok(value));
    }

    /// End the running request with an error and take the next one.
    fn fail_current(&mut self, error: ComputerError) {
        let Some(key) = self.current.take() else {
            return;
        };
        self.settle(key, error);
        self.pump();
    }

    fn pump(&mut self) {
        if self.current.is_some() || self.closed() {
            return;
        }
        let Some(key) = self.queue.pop_front() else {
            return;
        };
        self.current = Some(key);
        if let Some(job) = self.jobs.get_mut(&key)
            && let Some(timing) = job.timing.as_mut()
        {
            timing.dequeue();
        }
        self.write(key);
    }

    fn write(&mut self, key: u64) {
        // A stopping helper is out of service: its successor waits for its exit, so this
        // request is not handed to the helper being replaced (`helper-connection.ts:329`).
        let writing = self.child.as_ref().filter(|child| {
            self.stopping
                .as_ref()
                .is_none_or(|stopping| stopping.seq != child.seq)
        });
        match writing.map(|child| child.seq) {
            Some(seq) => self.send_job(key, seq),
            None => self.start_helper(),
        }
    }

    fn start_helper(&mut self) {
        if self.starting.is_some() {
            return;
        }
        if self.stopping.is_some() {
            // A successor waits for the stopping helper; its exit resumes the queue, and one
            // that refuses SIGKILL refuses the request instead of starting another.
            if self.unkillable {
                let error = ComputerError::helper_stopping();
                self.fail_current(error);
            }
            return;
        }
        let seq = self.next_child;
        self.next_child += 1;
        self.starting = Some(seq);
        let events = Arc::new(ChannelEvents {
            tx: self.shared.tx.clone(),
            seq,
        });
        let started = self.options.start.start(events);
        let tx = self.shared.tx.clone();
        tokio::spawn(async move {
            let result = started.await;
            let _ = tx.send(Cmd::Started { seq, result });
        });
    }

    fn started(&mut self, seq: u64, result: Result<Box<dyn HelperProcess>, ComputerError>) {
        if self.starting != Some(seq) {
            // A start the state no longer wants (it was closed, or replaced).
            if let Ok(process) = result {
                let _ = process;
            }
            return;
        }
        self.starting = None;
        match result {
            Err(error) => {
                for waiter in self.pid_waiters.drain(..) {
                    let _ = waiter.send(None);
                }
                self.fail_current(error);
            }
            Ok(process) => {
                if self.exited_while_starting.remove(&seq) {
                    // It exited before it was installed: it never gets the request.
                    self.fail_current(ComputerError::helper_exited());
                    return;
                }
                let pid = process.pid();
                let lines = ReplyLines::new(self.options.max_reply_bytes);
                self.child = Some(ChildHandle {
                    seq,
                    process,
                    lines,
                });
                for waiter in self.pid_waiters.drain(..) {
                    let _ = waiter.send(Some(pid));
                }
                if self.closed() {
                    self.kill();
                    return;
                }
                if let Some(key) = self.current {
                    self.send_job(key, seq);
                }
            }
        }
    }

    /// Hand the running request to `seq`'s helper, through its dispatch if it has one.
    fn send_job(&mut self, key: u64, seq: u64) {
        let Some(job) = self.jobs.get_mut(&key) else {
            return;
        };
        if job.ending.is_some() {
            return;
        }
        match job.dispatch.as_ref().map(Arc::clone) {
            Some(dispatch) => {
                let tx = self.shared.tx.clone();
                tokio::spawn(async move {
                    let ready = dispatch.ready().await;
                    let _ = tx.send(Cmd::DispatchReady { key, ready });
                });
            }
            None => self.deliver(key, seq),
        }
    }

    fn dispatch_ready(&mut self, key: u64, ready: Result<bool, String>) {
        if self.current != Some(key) {
            return;
        }
        match ready {
            Err(message) => {
                let error = ComputerError::new("cancelled", message);
                self.current = None;
                self.settle(key, error);
                self.pump();
            }
            Ok(true) => {
                let authorized = self
                    .jobs
                    .get(&key)
                    .and_then(|job| job.dispatch.as_ref().map(|dispatch| dispatch.authorize()))
                    .unwrap_or(false);
                if !authorized {
                    self.park(key);
                    return;
                }
                match self.child.as_ref().map(|child| child.seq) {
                    Some(seq) => self.deliver(key, seq),
                    None => self.start_helper(),
                }
            }
            Ok(false) => self.park(key),
        }
    }

    /// `helper-connection.ts:257`: the request waits outside the queue, and its slot is free.
    fn park(&mut self, key: u64) {
        self.parked.insert(key);
        self.current = None;
        self.pump();
        let token = CancellationToken::new();
        let Some(dispatch) = self.jobs.get_mut(&key).map(|job| {
            job.wait_token = Some(token.clone());
            job.dispatch.as_ref().map(Arc::clone)
        }) else {
            return;
        };
        let Some(dispatch) = dispatch else {
            return;
        };
        let tx = self.shared.tx.clone();
        tokio::spawn(async move {
            let woken = dispatch.wait(token).await;
            let _ = tx.send(Cmd::DispatchWoke { key, woken });
        });
    }

    fn dispatch_woke(&mut self, key: u64, woken: Result<(), String>) {
        if !self.parked.remove(&key) {
            return;
        }
        match woken {
            Ok(()) => {
                self.queue.push_back(key);
                self.pump();
            }
            Err(message) => {
                let error = ComputerError::new("cancelled", message);
                self.settle(key, error);
                self.pump();
            }
        }
    }

    /// Write the request's line to `seq`'s helper (`helper-connection.ts:230`-`:254`).
    fn deliver(&mut self, key: u64, seq: u64) {
        if self.child.as_ref().map(|child| child.seq) != Some(seq) {
            self.current = None;
            self.settle(key, ComputerError::helper_exited());
            self.pump();
            return;
        }
        let Some(job) = self.jobs.get_mut(&key) else {
            return;
        };
        job.child = Some(seq);
        let line = job.line.clone();
        if let Some(timing) = job.timing.as_mut() {
            timing.ready();
        }
        if let Some(child) = self.child.as_ref() {
            child.process.write(line);
        }
    }

    /// Stop a request (`helper-connection.ts:282`): unsent ones end now; a sent one gets the
    /// helper's own `cancel` and a grace period.
    fn cancel(&mut self, key: u64, why: Ending) {
        let Some(job) = self.jobs.get_mut(&key) else {
            return;
        };
        if job.ending.is_some() {
            return;
        }
        job.ending = Some(why);
        if self.parked.remove(&key) {
            if let Some(token) = job.wait_token.take() {
                token.cancel();
            }
            let error = ending_error(why, None);
            self.settle(key, error);
            self.pump();
            return;
        }
        if let Some(index) = self.queue.iter().position(|queued| *queued == key) {
            self.queue.remove(index);
            let error = ending_error(why, None);
            self.settle(key, error);
            return;
        }
        if self.current != Some(key) {
            return;
        }
        let Some(seq) = self.jobs.get(&key).and_then(|job| job.child) else {
            let error = ending_error(why, None);
            self.current = None;
            self.settle(key, error);
            self.pump();
            return;
        };
        let target = self
            .jobs
            .get(&key)
            .map(|job| job.id.clone())
            .unwrap_or_default();
        let id = (self.options.next_id)();
        let mut cancel = Map::with_capacity(3);
        cancel.insert("id".to_owned(), Value::from(id.as_str()));
        cancel.insert("op".to_owned(), Value::from("cancel"));
        cancel.insert("target".to_owned(), Value::from(target.as_str()));
        let mut bytes = Value::Object(cancel).to_json().into_bytes();
        bytes.push(b'\n');
        if let Some(child) = self.child.as_ref()
            && child.seq == seq
        {
            child.process.write(bytes);
        }
        let grace_ms = self.options.grace_ms;
        let tx = self.shared.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(grace_ms)).await;
            let _ = tx.send(Cmd::Grace { key });
        });
    }

    /// The grace ran out: a helper that ignored the cancel is stuck, and this app's helper is
    /// replaced (`helper-connection.ts:301`-`:308`).
    fn grace(&mut self, key: u64) {
        if self.current != Some(key) {
            return;
        }
        let Some(job) = self.jobs.get(&key) else {
            return;
        };
        let Some(seq) = job.child else {
            return;
        };
        let why = job.ending.unwrap_or(Ending::Cancelled);
        if self.child.as_ref().map(|child| child.seq) == Some(seq) {
            self.kill();
        }
        self.current = None;
        let error = ending_error(why, None);
        self.settle(key, error);
        self.pump();
    }

    fn output(&mut self, child: u64, bytes: &[u8]) {
        let Some(handle) = self.child.as_mut().filter(|handle| handle.seq == child) else {
            return;
        };
        let lines = handle.lines.push(bytes);
        for line in lines {
            self.reply(child, line);
        }
    }

    fn reply(&mut self, child: u64, line: ReplyLine) {
        let Some(key) = self.current else {
            return;
        };
        if self
            .jobs
            .get(&key)
            .is_none_or(|job| job.child != Some(child))
        {
            return;
        }
        match line {
            ReplyLine::Oversize { id } => {
                if let Some(id) = id
                    && self.jobs.get(&key).is_some_and(|job| job.id != id)
                {
                    return;
                }
                self.current = None;
                let error = ComputerError::reply_too_large(self.options.max_reply_bytes);
                self.settle(key, error);
                self.pump();
            }
            ReplyLine::Line { text } => {
                let stamp = self
                    .jobs
                    .get(&key)
                    .and_then(|job| job.timing.as_ref().map(RequestSpan::stamp));
                let Some(reply) = decode_reply(&text) else {
                    return;
                };
                if self.jobs.get(&key).is_none_or(|job| job.id != reply.id()) {
                    return;
                }
                let ending = self.jobs.get(&key).and_then(|job| job.ending);
                if let Some(job) = self.jobs.get_mut(&key)
                    && let (Some(timing), Some(stamp)) = (job.timing.as_mut(), stamp)
                {
                    let result = reply.result();
                    timing.reply(stamp, result.as_ref());
                }
                match (ending, reply) {
                    (Some(why), Reply::Ok { result, .. }) => {
                        self.current = None;
                        let error = ending_error(why, Some(result));
                        self.settle(key, error);
                    }
                    (Some(why), Reply::Failed { .. }) => {
                        self.current = None;
                        let error = ending_error(why, None);
                        self.settle(key, error);
                    }
                    (None, Reply::Ok { result, .. }) => {
                        self.current = None;
                        self.resolve(key, result);
                    }
                    (None, Reply::Failed { code, message, .. }) => {
                        self.current = None;
                        let error = ComputerError::new(code, message);
                        self.settle(key, error);
                    }
                }
                self.pump();
            }
        }
    }

    fn exit(&mut self, child: u64) {
        if self.starting == Some(child) {
            // Its start has not been reported yet; remember it so `started` installs nothing.
            self.exited_while_starting.insert(child);
            return;
        }
        if self.child.as_ref().map(|handle| handle.seq) == Some(child) {
            self.child = None;
        }
        let stopping = self.stopping.as_ref().map(|stopping| stopping.seq) == Some(child);
        let running = self
            .current
            .and_then(|key| self.jobs.get(&key).map(|job| (job.child, job.ending)));
        if let Some((Some(seq), ending)) = running
            && seq == child
        {
            let error = match ending {
                Some(why) => ending_error(why, None),
                None => ComputerError::helper_exited(),
            };
            self.fail_current(error);
        }
        if stopping {
            self.finish_stopping();
        }
    }

    fn stdin_error(&mut self, child: u64) {
        if self.child.as_ref().map(|handle| handle.seq) == Some(child) {
            self.kill();
        }
    }

    /// Take the helper out of service; it stays owned until it has exited
    /// (`helper-connection.ts:420`).
    fn kill(&mut self) {
        let Some(child) = self.child.as_ref() else {
            return;
        };
        let seq = child.seq;
        if self.stopping.as_ref().map(|stopping| stopping.seq) == Some(seq) {
            return;
        }
        self.stopping = Some(Stopping {
            seq,
            terminated: false,
        });
        child.process.end_stdin();
        let stop_grace_ms = self.options.stop_grace_ms;
        if stop_grace_ms > 0 {
            self.arm_stop(seq, StopStep::Terminate, stop_grace_ms);
        } else {
            self.terminate(seq);
        }
    }

    fn terminate(&mut self, seq: u64) {
        if self.stopping.as_ref().map(|stopping| stopping.seq) != Some(seq) {
            return;
        }
        if let Some(stopping) = self.stopping.as_mut() {
            stopping.terminated = true;
        }
        if let Some(child) = self.child.as_ref()
            && child.seq == seq
        {
            child.process.kill(SignalName::Term);
        }
        let force_kill_ms = self.options.force_kill_ms;
        self.arm_stop(seq, StopStep::Force, force_kill_ms);
    }

    fn arm_stop(&mut self, seq: u64, step: StopStep, ms: u64) {
        let tx = self.shared.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            let _ = tx.send(Cmd::StopStep { seq, step });
        });
    }

    fn stop_step(&mut self, seq: u64, step: StopStep) {
        if self.stopping.as_ref().map(|stopping| stopping.seq) != Some(seq) {
            return;
        }
        match step {
            // The kernel took SIGKILL; the exit report is all that is left.
            StopStep::ForceBound => self.finish_stopping(),
            StopStep::Terminate => self.terminate(seq),
            StopStep::Force => {
                let killed = self
                    .child
                    .as_ref()
                    .filter(|child| child.seq == seq)
                    .is_some_and(|child| child.process.kill(SignalName::Kill));
                if killed {
                    let force_kill_ms = self.options.force_kill_ms;
                    self.arm_stop(seq, StopStep::ForceBound, force_kill_ms);
                } else if self.child.is_some() {
                    // Refused: the helper may still run, so it stays owned until its exit,
                    // and the request waiting for its successor is refused at once with
                    // `helper_stopping` instead of waiting for its deadline (`:451`, `:126`).
                    self.unkillable = true;
                    // Wake waiters already waiting on the stop (`:451`, `:131`): no successor
                    // may start while the old helper lives, so they fail at once instead.
                    for waiter in self.stopped_waiters.drain(..) {
                        let _ = waiter.send(Err(ComputerError::helper_stopping()));
                    }
                    if self.current.is_some() {
                        self.fail_current(ComputerError::helper_stopping());
                    }
                }
            }
        }
    }

    fn finish_stopping(&mut self) {
        let Some(stopping) = self.stopping.take() else {
            return;
        };
        // A helper whose SIGKILL the kernel took is gone, even if its exit event was lost.
        if self.child.as_ref().map(|child| child.seq) == Some(stopping.seq) {
            self.child = None;
        }
        self.unkillable = false;
        self.advance();
    }

    /// Resume whatever the state was waiting for: the running request, or the next one.
    fn advance(&mut self) {
        match self.current {
            Some(key) => self.write(key),
            None => self.pump(),
        }
    }

    fn pid(&mut self, reply: oneshot::Sender<Option<u32>>) {
        if self.closed() {
            let _ = reply.send(None);
            return;
        }
        if let Some(child) = self.child.as_ref() {
            let _ = reply.send(Some(child.process.pid()));
            return;
        }
        self.pid_waiters.push(reply);
        if self.stopping.is_none() {
            self.start_helper();
        }
    }

    fn wait_stopped(&mut self, reply: oneshot::Sender<Result<(), ComputerError>>) {
        if self.starting.is_none() && self.stopping.is_none() {
            let _ = reply.send(Ok(()));
            return;
        }
        if self.unkillable {
            let _ = reply.send(Err(ComputerError::helper_stopping()));
            return;
        }
        self.stopped_waiters.push(reply);
    }

    fn wait_gone(&mut self, reply: oneshot::Sender<()>) {
        if self.starting.is_none() && self.stopping.is_none() {
            let _ = reply.send(());
            return;
        }
        self.gone_waiters.push(reply);
    }

    fn settle_waiters(&mut self) {
        if self.starting.is_some() || self.stopping.is_some() {
            return;
        }
        for waiter in self.stopped_waiters.drain(..) {
            let _ = waiter.send(Ok(()));
        }
        for waiter in self.gone_waiters.drain(..) {
            let _ = waiter.send(());
        }
    }

    fn close(&mut self) {
        self.shutdown = true;
        if let Some(key) = self.current.take() {
            self.settle(key, ComputerError::stopped());
        }
        for key in self.queue.drain(..).collect::<Vec<_>>() {
            self.settle(key, ComputerError::stopped());
        }
        for key in self.parked.drain().collect::<Vec<_>>() {
            self.settle(key, ComputerError::stopped());
        }
        self.kill();
    }

    fn idle_changed(&mut self) {
        let idle = !self.busy();
        if idle != self.idle {
            self.idle = idle;
            (self.options.idle)(idle);
        }
    }
}

/// Why a cancelled or overrun request ended, with what the helper replied
/// (`helper-connection.ts:65`).
fn ending_error(ending: Ending, result: Option<Value>) -> ComputerError {
    match ending {
        Ending::Timeout => ComputerError::timeout().with_result(result),
        Ending::Cancelled => ComputerError::cancelled().with_result(result),
    }
}

/// One spawned helper's events into its connection.
struct ChannelEvents {
    tx: mpsc::UnboundedSender<Cmd>,
    seq: u64,
}

impl ChildEvents for ChannelEvents {
    fn output(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(Cmd::Output {
            child: self.seq,
            bytes,
        });
    }

    fn exit(&self) {
        let _ = self.tx.send(Cmd::Exit { child: self.seq });
    }

    fn stdin_error(&self) {
        let _ = self.tx.send(Cmd::StdinError { child: self.seq });
    }
}

#[cfg(test)]
mod tests;
