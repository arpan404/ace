//! Spade's end of the pipe (ADR 0203 §3, §4): a started `spade-wasm`, its loads and calls. A call
//! is a [`Running`]: it yields each request the component makes of Spade, for Spade to carry out
//! after its gate and answer, then its [`Outcome`]. Stop asks the worker to end calls and kills
//! it when one is still open a second later. A worker that dies with calls open reports each as
//! stopped (when Stop was asked) or lost: never done.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use spade_core::package::code::Bounds;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{OwnedSemaphorePermit, mpsc, oneshot};

use crate::frame;
use crate::protocol::{Answer, Cut, FromWorker, HostRequest, Stats, Target, ToWorker};

/// How long Stop waits for the worker to end a call before it kills the worker.
pub const STOP_GRACE: Duration = Duration::from_secs(1);
/// Why a message didn't cross the pipe: it was too large.
const TOO_LARGE: &str = "is larger than the 16 MiB the pipe carries";
/// How long a new worker has to say it is ready.
const READY_WITHIN: Duration = Duration::from_secs(10);

/// How a call ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The component answered: its output, or the failure it gave.
    Done {
        output: Result<String, String>,
        stats: Stats,
        logs: Vec<String>,
    },
    /// It gave no answer.
    Failed {
        cut: Cut,
        message: String,
        stats: Stats,
        logs: Vec<String>,
    },
}

impl Outcome {
    fn ended(cut: Cut) -> Self {
        Self::Failed {
            cut,
            message: match cut {
                Cut::Stopped => "it was stopped".to_owned(),
                _ => "its worker ended during the call, so what it did is unknown".to_owned(),
            },
            stats: Stats::default(),
            logs: Vec::new(),
        }
    }

    /// Why it gave no answer; `None` when it answered.
    pub fn cut(&self) -> Option<Cut> {
        match self {
            Self::Done { .. } => None,
            Self::Failed { cut, .. } => Some(*cut),
        }
    }
}

/// What a running call says next.
#[derive(Debug)]
pub enum Event {
    /// The component asks Spade for this; answer with [`Running::reply`].
    Host {
        request: u64,
        call: HostRequest,
    },
    End(Outcome),
}

/// Who waits for a component to compile.
type LoadWaiter = oneshot::Sender<Result<(), String>>;

struct Inner {
    stdin: tokio::sync::Mutex<ChildStdin>,
    child: Mutex<Child>,
    calls: Mutex<HashMap<u64, mpsc::UnboundedSender<Event>>>,
    stopped: Mutex<HashSet<u64>>,
    loads: Mutex<HashMap<String, Vec<LoadWaiter>>>,
    alive: AtomicBool,
    next: AtomicU64,
}

/// A started worker. Cloning shares it.
#[derive(Clone)]
pub struct Worker {
    inner: Arc<Inner>,
}

impl Worker {
    /// Starts `command` (a launch of `spade-wasm`, sandboxed or not) and waits for it to be
    /// ready.
    pub async fn start(mut command: Command) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Only the worker writes here (a component has no standard streams): its own errors,
            // such as an engine that didn't start, go to Spade's log.
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| format!("the code worker didn't start: {e}"))?;
        let (Some(stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err("the code worker has no pipe".to_owned());
        };
        let ready =
            tokio::time::timeout(READY_WITHIN, frame::read_async::<FromWorker>(&mut stdout))
                .await
                .map_err(|_| "the code worker didn't say it was ready".to_owned())?;
        match ready {
            Ok(Some(FromWorker::Ready { .. })) => {}
            Ok(_) => return Err("the code worker ended before it was ready".to_owned()),
            Err(error) => return Err(format!("the code worker's pipe: {error}")),
        }
        let inner = Arc::new(Inner {
            stdin: tokio::sync::Mutex::new(stdin),
            child: Mutex::new(child),
            calls: Mutex::default(),
            stopped: Mutex::default(),
            loads: Mutex::default(),
            alive: AtomicBool::new(true),
            next: AtomicU64::new(1),
        });
        tokio::spawn(read(Arc::clone(&inner), stdout));
        Ok(Self { inner })
    }

    pub fn alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    /// The worker's process id, while it runs.
    pub fn pid(&self) -> Option<u32> {
        self.inner.child.lock().ok().and_then(|child| child.id())
    }

    /// Sends `message`. A pipe that fails ends the worker, so every open call reads stopped or
    /// lost and none waits on a message that never came; a message too large to send fails alone.
    async fn send(&self, message: &ToWorker) -> Result<(), String> {
        let mut stdin = self.inner.stdin.lock().await;
        match frame::write_async(&mut *stdin, message).await {
            Ok(()) => Ok(()),
            Err(error) if frame::too_large(&error) => Err(TOO_LARGE.to_owned()),
            Err(error) => {
                drop(stdin);
                self.kill();
                Err(format!("the code worker's pipe: {error}"))
            }
        }
    }

    /// Compiles the component at `path` (in the worker's folder), whose sha256 is `component`.
    pub async fn load(&self, component: &str, path: &Path) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut loads) = self.inner.loads.lock() {
            loads.entry(component.to_owned()).or_default().push(tx);
        }
        self.send(&ToWorker::Load {
            component: component.to_owned(),
            path: path.to_owned(),
        })
        .await?;
        rx.await
            .unwrap_or_else(|_| Err("the code worker ended while it compiled".to_owned()))
    }

    /// Starts a call of `target` in `component`.
    pub async fn call(
        &self,
        component: &str,
        target: Target,
        input: &str,
        bounds: Bounds,
    ) -> Result<Running, String> {
        if !self.alive() {
            return Err("the code worker has ended".to_owned());
        }
        let id = self.inner.next.fetch_add(1, Ordering::SeqCst);
        let (tx, events) = mpsc::unbounded_channel();
        if let Ok(mut calls) = self.inner.calls.lock() {
            calls.insert(id, tx);
        }
        let sent = self
            .send(&ToWorker::Call {
                id,
                component: component.to_owned(),
                target,
                input: input.to_owned(),
                bounds,
            })
            .await;
        if let Err(why) = sent {
            if let Ok(mut calls) = self.inner.calls.lock() {
                calls.remove(&id);
            }
            return Err(why);
        }
        Ok(Running {
            id,
            events,
            worker: self.clone(),
            _slot: None,
        })
    }

    /// Ends call `id`, or every open call: at once, or by killing the worker after
    /// [`STOP_GRACE`]. Returns when Stop was sent.
    pub async fn stop(&self, id: Option<u64>) {
        let targets: Vec<u64> = match self.inner.calls.lock() {
            Ok(calls) => calls
                .keys()
                .copied()
                .filter(|k| id.is_none_or(|id| *k == id))
                .collect(),
            Err(_) => Vec::new(),
        };
        if let Ok(mut stopped) = self.inner.stopped.lock() {
            stopped.extend(targets.iter().copied());
        }
        if self.send(&ToWorker::Stop { id }).await.is_err() {
            self.kill();
            return;
        }
        let worker = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STOP_GRACE).await;
            let open = worker
                .inner
                .calls
                .lock()
                .map(|calls| targets.iter().any(|id| calls.contains_key(id)))
                .unwrap_or(true);
            if open {
                worker.kill();
            }
        });
    }

    /// Kills the worker: every open call reports stopped or lost.
    pub fn kill(&self) {
        if let Ok(mut child) = self.inner.child.lock() {
            let _ = child.start_kill();
        }
    }
}

/// Routes the worker's frames until its pipe closes, then ends every open call and load.
async fn read(inner: Arc<Inner>, mut stdout: tokio::process::ChildStdout) {
    while let Ok(Some(message)) = frame::read_async::<FromWorker>(&mut stdout).await {
        match message {
            FromWorker::Ready { .. } => {}
            FromWorker::Loaded { component } => finish_load(&inner, &component, Ok(())),
            FromWorker::LoadFailed { component, reason } => {
                finish_load(&inner, &component, Err(reason));
            }
            FromWorker::Host { id, request, call } => {
                if let Ok(calls) = inner.calls.lock()
                    && let Some(tx) = calls.get(&id)
                {
                    let _ = tx.send(Event::Host { request, call });
                }
            }
            FromWorker::Done {
                id,
                output,
                stats,
                logs,
            } => end(
                &inner,
                id,
                Outcome::Done {
                    output,
                    stats,
                    logs,
                },
            ),
            FromWorker::Failed {
                id,
                cut,
                message,
                stats,
                logs,
            } => end(
                &inner,
                id,
                Outcome::Failed {
                    cut,
                    message,
                    stats,
                    logs,
                },
            ),
        }
    }
    inner.alive.store(false, Ordering::SeqCst);
    // Make sure it is gone, then answer everything still open.
    if let Ok(mut child) = inner.child.lock() {
        let _ = child.start_kill();
    }
    let open: Vec<(u64, mpsc::UnboundedSender<Event>)> = inner
        .calls
        .lock()
        .map(|mut calls| calls.drain().collect())
        .unwrap_or_default();
    let stopped = inner.stopped.lock().map(|s| s.clone()).unwrap_or_default();
    for (id, tx) in open {
        let cut = if stopped.contains(&id) {
            Cut::Stopped
        } else {
            Cut::Lost
        };
        let _ = tx.send(Event::End(Outcome::ended(cut)));
    }
    let loads: Vec<_> = inner
        .loads
        .lock()
        .map(|mut loads| loads.drain().collect())
        .unwrap_or_default();
    for (_, waiters) in loads {
        for tx in waiters {
            let _ = tx.send(Err("the code worker ended while it compiled".to_owned()));
        }
    }
}

fn finish_load(inner: &Inner, component: &str, result: Result<(), String>) {
    let waiters = inner
        .loads
        .lock()
        .ok()
        .and_then(|mut loads| loads.remove(component))
        .unwrap_or_default();
    for tx in waiters {
        let _ = tx.send(result.clone());
    }
}

fn end(inner: &Inner, id: u64, outcome: Outcome) {
    let tx = inner
        .calls
        .lock()
        .ok()
        .and_then(|mut calls| calls.remove(&id));
    if let Ok(mut stopped) = inner.stopped.lock() {
        stopped.remove(&id);
    }
    if let Some(tx) = tx {
        let _ = tx.send(Event::End(outcome));
    }
}

/// A call in progress.
pub struct Running {
    pub id: u64,
    events: mpsc::UnboundedReceiver<Event>,
    worker: Worker,
    /// The bot's slot, held until the call ends.
    _slot: Option<OwnedSemaphorePermit>,
}

impl Running {
    pub(crate) fn holding(mut self, slot: OwnedSemaphorePermit) -> Self {
        self._slot = Some(slot);
        self
    }

    /// The worker the call runs on.
    pub fn worker(&self) -> &Worker {
        &self.worker
    }

    /// The next request, or the end.
    pub async fn next(&mut self) -> Event {
        self.events
            .recv()
            .await
            .unwrap_or(Event::End(Outcome::ended(Cut::Lost)))
    }

    /// Spade's answer to the component's `request`. One too large for the pipe reaches the
    /// component as a short failure instead, so the call never waits on it.
    pub async fn reply(&self, request: u64, answer: Answer) -> Result<(), String> {
        let sent = self
            .worker
            .send(&ToWorker::Reply {
                id: self.id,
                request,
                answer,
            })
            .await;
        match sent {
            Err(why) if why == TOO_LARGE => {
                let short = Err(format!("Spade's answer {TOO_LARGE}"));
                let sent = self
                    .worker
                    .send(&ToWorker::Reply {
                        id: self.id,
                        request,
                        answer: short,
                    })
                    .await;
                if sent.is_err() {
                    self.worker.kill();
                }
                sent
            }
            sent => sent,
        }
    }

    /// Runs the call to its end, answering each request with `host`.
    pub async fn finish<F, Fut>(mut self, mut host: F) -> Outcome
    where
        F: FnMut(HostRequest) -> Fut,
        Fut: std::future::Future<Output = Answer>,
    {
        loop {
            match self.next().await {
                Event::Host { request, call } => {
                    let answer = host(call).await;
                    // A worker that's gone ends the call through `next`.
                    let _ = self.reply(request, answer).await;
                }
                Event::End(outcome) => return outcome,
            }
        }
    }
}
