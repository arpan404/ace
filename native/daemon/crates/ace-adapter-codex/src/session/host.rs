// SPDX-License-Identifier: Apache-2.0
//! One `codex app-server` process, shared by many ace sessions (`CodexHost`,
//! `host.ts:193`–`:690`). Each session is a *tenant*: a channel that sees only
//! the native threads it opened and their descendants. A tenant is registered
//! before initialization completes, so a dedicated channel sees every frame
//! live; the init frames are replayed to every tenant that attaches.
//!
//! Sans-IO like `PiWire` and `RpcPeer`: every input — a framed stdout line, a
//! stderr line, a write acknowledgement, a timer, a detach — runs one method
//! under this host's lock and returns the effects the shell must apply, in the
//! order the state changed. Tenant callbacks are `ChannelHandlers`; the shell
//! owns the child, its stdin queue and the timers (E3.0b).
//!
//! An unowned thread is never guessed onto a tenant: its frames are held while
//! Codex's own thread records are read, then flushed to the ancestor's owner
//! or, when the ancestry reaches no ace thread, dropped *as frames* with the
//! request that waited answered, as today (`#resolve`, `:635`–`:680`).
//!
//! What the TypeScript host does around the core stays the shell's: the
//! spawn and its diversion (E3.0b), the stop plan and the Windows tree stop
//! (`graceMs`, `stopTree`, `platform`), and the model-catalog cache a channel
//! shares (`CodexCatalogCache`, `tool-facts.ts`, which E3-codex.3 ports).

mod gate;
mod holds;

pub use gate::HostGate;
use holds::{Held, Hold};

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::{
    Direction, INTERNAL_ERROR, METHOD_NOT_FOUND, PeerConfig, PeerEffect, PeerError, RpcPeer,
    Timeout,
};
use ace_supervisor::spawn::{Delivered, RawExit};
use indexmap::IndexMap;

use super::routing::{HostRouter, Route, parent_of};

/// Held threads kept while their ancestry is unknown (`holdThreads`, `:106`).
const HOLD_THREADS: usize = 64;
/// Frames held per thread before they fall back to every channel's own
/// discovery (`holdFrames`, `:107`).
const HOLD_FRAMES: usize = 256;
/// How far Codex's records are walked for an owned ancestor (`ancestryDepth`).
const ANCESTRY_DEPTH: usize = 16;
/// A detached tenant's unsubscribes (`unsubscribeMs`, `:109`).
const UNSUBSCRIBE_MS: f64 = 10_000.0;
/// One ancestry read (`readMs`, `:110`).
const READ_MS: f64 = 10_000.0;
/// The host's `initialize` deadline (`host.ts:283`).
const INITIALIZE_MS: f64 = 30_000.0;
/// The host's own request ids start here; a facade's ids are small counters, so
/// a `Settle` in this range never leaves the host.
const OWN_ID_BASE: u64 = 1 << 63;
/// A close's `turn/interrupt` deadline, the session's own (`session-commands.ts`).
const INTERRUPT_MS: f64 = 10_000.0;
/// The idle deadline's facade key.
pub const IDLE_TIMER: &str = "host:idle";
/// A shared host's pending-request bound (`host.ts:256`).
const SHARED_MAX_PENDING: usize = 1024;
/// A shared host's server-request bound (`host.ts:256`).
const SHARED_MAX_INCOMING: usize = 512;
/// Why an output line was dropped (`OutputLineDroppedError`'s message).
fn dropped_message(bytes: usize) -> String {
    format!(
        "Codex stdout reply dropped because its line exceeded the limit (at least {bytes} bytes)"
    )
}

/// Why a host is going away (`Retirement`, `host.ts:49`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retirement {
    Idle,
    User,
    Shutdown,
    Aborted,
    OpenFailed,
    RpcFailed,
}

impl Retirement {
    /// The reason as `host.ts` spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Retirement::Idle => "idle",
            Retirement::User => "user",
            Retirement::Shutdown => "shutdown",
            Retirement::Aborted => "aborted",
            Retirement::OpenFailed => "open_failed",
            Retirement::RpcFailed => "rpc_failed",
        }
    }
}

/// How a host's process ended (`ProcessExit["reason"]` plus `detached`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    Exit,
    Signal,
    Stopped,
    SpawnError,
    OutputLimit,
    /// A shared process stopped serving one channel.
    Detached,
}

impl ExitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ExitReason::Exit => "exit",
            ExitReason::Signal => "signal",
            ExitReason::Stopped => "stopped",
            ExitReason::SpawnError => "spawn-error",
            ExitReason::OutputLimit => "output-limit",
            ExitReason::Detached => "detached",
        }
    }
}

/// A process exit as a channel hears it (`HostExit`, `:22`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostExit {
    pub reason: ExitReason,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub pid: Option<u32>,
    /// False means the final descriptor drain was cut short.
    pub output_drained: bool,
}

impl HostExit {
    /// The exit the leader reported, with the host's pid and drain state.
    pub fn from_raw(exit: RawExit, pid: Option<u32>, output_drained: bool) -> HostExit {
        HostExit {
            reason: if exit.signal.is_some() {
                ExitReason::Signal
            } else {
                ExitReason::Exit
            },
            code: exit.code,
            signal: exit.signal,
            pid,
            output_drained,
        }
    }
}

/// Which part of a dropped line the supervisor lost (`DroppedOutputLine`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DroppedPhase {
    Line,
    End,
}

/// One output line the supervisor dropped, already attributed by
/// `attributeDroppedLine` (`dropped-line.ts`), which E3-codex.3 ports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DroppedLine {
    pub bytes: usize,
    pub phase: DroppedPhase,
    /// The thread the line named, when it named one.
    pub thread: Option<JsString>,
    /// The request whose reply this line was.
    pub response: Option<RpcId>,
}

/// What `frame` did with a received frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    Taken,
    /// Nothing after an unadmitted frame may reach translation, as when a
    /// private peer closes.
    Failed(String),
}

/// What a tenant did with a server request (`ChannelHandlers.request`).
#[derive(Debug, Clone, PartialEq)]
pub enum RequestAnswer {
    Answered(Value),
    /// `MethodNotFound`: `-32601`.
    MethodNotFound(String),
    /// Any other failure: `-32603`.
    Failed(String),
    /// The session answers later through `Host::answer`.
    Deferred,
}

/// One tenant's callbacks (`ChannelHandlers`, `host.ts:29`). A handler never
/// calls back into the host: it publishes onto its own ordered queue (E3.0c),
/// which is what lets the host hold its lock across a delivery.
pub trait ChannelHandlers: Send + Sync {
    fn frame(&self, dir: Direction, data: &Value) -> Admission;
    fn notification(&self, method: &JsString, params: Option<&Value>);
    fn request(&self, id: &RpcId, method: &JsString, params: Option<&Value>) -> RequestAnswer;
    fn dropped(&self, line: &DroppedLine);
    fn output_uncertain(&self);
    fn malformed(&self, line: &str);
    fn stderr(&self, line: &str);
    fn error(&self, message: &str);
    /// A received frame could not be admitted; the channel must retire.
    fn failed(&self, message: &str);
    /// Called once, after detach completes or the process exits.
    fn exited(&self, exit: &HostExit);
    /// Initialization completed: the open promise resolves.
    fn ready(&self);
}

/// What the shell must do for the host (the promises `CodexHost` keeps).
#[derive(Debug, Clone, PartialEq)]
pub enum HostEffect {
    /// One line for the child's stdin, then `written(ticket)`.
    Write {
        wire: Vec<u8>,
        ticket: u64,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// Settles the facade's promise `id`, once.
    Settle {
        id: u64,
        result: Result<Value, PeerError>,
    },
    /// Stop the child. `awaited` is a caller's retire; an idle one is nobody's
    /// to see, so the shell reports its failure itself.
    Retire {
        reason: Retirement,
        awaited: bool,
    },
    /// `onRetired`: the pool forgets this host.
    Retired,
    /// The tenant's open promise resolves.
    Opened {
        tenant: u64,
    },
    /// The tenant's open promise rejects; the tenant is gone.
    OpenFailed {
        tenant: u64,
        message: String,
    },
    /// A channel's exit, queued after every settlement that precedes it, so
    /// the shell never reports a channel gone while its calls are still open.
    Exited {
        tenant: u64,
        exit: HostExit,
    },
    /// A retire asked while one is already in flight: the caller joins that
    /// stop, whose outcome the shell already holds.
    Retiring {
        reason: Retirement,
    },
}

/// A refusal at the host's own door.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    #[error("Codex app-server is not available")]
    Unavailable,
    #[error("Dedicated Codex host is in use")]
    DedicatedInUse,
    /// The peer refused the call (`JSON-RPC pending request limit`, a stopped
    /// peer), or the channel is closed.
    #[error("{0}")]
    Refused(String),
}

/// What `Host::new` needs.
#[derive(Debug, Clone, PartialEq)]
pub struct HostConfig {
    /// A dedicated host serves one channel and stops with it.
    pub dedicated: bool,
    pub initialize: Value,
    /// How long a shared host with no channels stays up for the next session.
    pub idle_ms: f64,
    /// `None` leaves requests without a default deadline, as `timeoutMs: null`.
    pub timeout_ms: Option<f64>,
}

impl HostConfig {
    /// A dedicated host: one channel, stopped with it.
    pub fn dedicated(initialize: Value) -> HostConfig {
        HostConfig {
            dedicated: true,
            initialize,
            idle_ms: 0.0,
            timeout_ms: None,
        }
    }

    /// A shared host: many channels, kept for `idle_ms` when empty.
    pub fn shared(initialize: Value, idle_ms: f64) -> HostConfig {
        HostConfig {
            dedicated: false,
            initialize,
            idle_ms,
            timeout_ms: None,
        }
    }

    fn peer(&self) -> PeerConfig {
        let defaults = PeerConfig::default();
        PeerConfig {
            timeout_ms: self.timeout_ms,
            max_pending: if self.dedicated {
                defaults.max_pending
            } else {
                SHARED_MAX_PENDING
            },
            max_queued_bytes: defaults.max_queued_bytes,
            max_incoming: if self.dedicated {
                defaults.max_incoming
            } else {
                SHARED_MAX_INCOMING
            },
        }
    }
}

/// A tenant: one session's channel (`Tenant`, `:121`).
struct Tenant {
    handlers: Arc<dyn ChannelHandlers>,
    /// Set once the channel stopped serving this process.
    closed: Option<String>,
    /// A received frame failed admission; requests still flow so the tree can
    /// be stopped.
    muted: bool,
    exited: bool,
}

/// A channel that is leaving: it issues nothing new, keeps delivering the
/// frames its threads still produce, and exits when its last unsubscribe lands.
struct Detaching {
    remaining: usize,
    retirement: Retirement,
    phase: Leaving,
}

/// How far a leaving channel has gone: its turns are interrupted, then its
/// threads released and unsubscribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leaving {
    Interrupts,
    Unsubscribes,
}

/// Why the host itself made a request.
#[derive(Debug, Clone)]
enum OwnPurpose {
    /// One step of a held thread's ancestry walk, tied to the hold that asked.
    Read { thread: JsString, hold: u64 },
    /// A detached channel's unsubscribes.
    Unsubscribe { tenant: u64 },
    /// A close's `turn/interrupt`; its answer starts the release.
    Interrupt { tenant: u64 },
}

/// The message just received, for the dispatch effect that follows it
/// (`#last`, `:205`).
struct Pending {
    route: Route<u64>,
    /// Kept only for the lone-channel host-request fallback (`:565`).
    data: Option<Value>,
    held: Option<(JsString, usize)>,
    failed: HashSet<u64>,
}

/// When the host's `initialize` handshake has got to.
#[derive(Debug, Clone, PartialEq)]
enum Handshake {
    Initializing,
    Open,
    Failed(String),
}

struct Inner {
    config: HostConfig,
    gate: HostGate,
    router: HostRouter<u64>,
    tenants: IndexMap<u64, Tenant>,
    holds: IndexMap<JsString, Hold>,
    init_frames: Vec<(Direction, Value)>,
    peer: RpcPeer,
    pid: Option<u32>,
    /// The leader's end, recorded while the pipes still drain (`#exit`).
    leader: Option<HostExit>,
    /// The final exit, published once the pipes are done (`#exited`).
    exit: Option<HostExit>,
    retiring: bool,
    retired: bool,
    output_drained: bool,
    /// The wire id of `initialize`, so its reply is recognized as an init frame.
    initialize_id: Option<RpcId>,
    /// The facade id of the `initialize` call.
    initialize_call: u64,
    /// The tenant whose request is being written, for the send frame's owner.
    sender: Option<u64>,
    own: HashMap<u64, OwnPurpose>,
    /// Facade ids a channel is waiting on, by tenant (`Tenant.abort`).
    calls: IndexMap<u64, u64>,
    /// Each thread's running turn, so a close can interrupt it.
    active: IndexMap<JsString, JsString>,
    /// The leader is gone or the pipes are closing: held frames are answered,
    /// never delivered, as `#exited` does.
    exiting: bool,
    detaching: IndexMap<u64, Detaching>,
    next_own: u64,
    next_hold: u64,
    ready: Handshake,
    idle_armed: bool,
    out: Vec<HostEffect>,
}

/// One app-server process and every channel on it.
pub struct Host {
    inner: Mutex<Inner>,
    gate: HostGate,
}

impl Host {
    /// A host over an already spawned child: it sends `initialize` at once, as
    /// the constructor does.
    pub fn new(config: HostConfig) -> (Host, Vec<HostEffect>) {
        let gate = HostGate::new();
        let peer = RpcPeer::new(config.peer());
        let host = Host {
            inner: Mutex::new(Inner {
                config,
                gate: gate.clone(),
                router: HostRouter::default(),
                tenants: IndexMap::new(),
                holds: IndexMap::new(),
                init_frames: Vec::new(),
                peer,
                pid: None,
                leader: None,
                exit: None,
                retiring: false,
                retired: false,
                output_drained: true,
                initialize_id: None,
                initialize_call: 0,
                sender: None,
                own: HashMap::new(),
                calls: IndexMap::new(),
                active: IndexMap::new(),
                exiting: false,
                detaching: IndexMap::new(),
                next_own: 0,
                next_hold: 0,
                ready: Handshake::Initializing,
                idle_armed: false,
                out: Vec::new(),
            }),
            gate,
        };
        let mut effects = Vec::new();
        {
            let mut inner = host.lock();
            let initialize = inner.config.initialize.clone();
            match inner.peer.request(
                "initialize",
                Some(&initialize),
                0,
                Timeout::After(INITIALIZE_MS),
            ) {
                Ok(peer) => inner.apply(peer),
                Err(error) => inner.ready = Handshake::Failed(error.message().to_owned()),
            }
            effects.extend(inner.take());
        }
        (host, effects)
    }

    /// The read gate the diverted child's chunks answer.
    pub fn gate(&self) -> &HostGate {
        &self.gate
    }

    /// The leader's pid, as the shell read it at spawn.
    pub fn set_pid(&self, pid: u32) {
        self.lock().pid = Some(pid);
    }

    pub fn pid(&self) -> Option<u32> {
        self.lock().pid
    }

    /// Accepts new channels: running, and not winding down.
    pub fn available(&self) -> bool {
        let inner = self.lock();
        inner.leader.is_none() && inner.exit.is_none() && !inner.retiring
    }

    /// The process leader already exited; final output may still be draining.
    pub fn gone(&self) -> bool {
        let inner = self.lock();
        inner.leader.is_some() || inner.exit.is_some()
    }

    pub fn dedicated(&self) -> bool {
        self.lock().config.dedicated
    }

    /// How many channels this process serves.
    pub fn tenant_count(&self) -> usize {
        self.lock().tenants.len()
    }

    /// No other channel shares this process.
    pub fn alone(&self, tenant: u64) -> bool {
        let inner = self.lock();
        inner.tenants.len() <= 1 && inner.tenants.contains_key(&tenant)
    }

    /// The thread provably belongs to another channel on this process.
    pub fn foreign(&self, tenant: u64, thread: &JsString) -> bool {
        let inner = self.lock();
        match inner.router.owner(thread) {
            Some(owner) => *owner != tenant,
            None => inner.router.released(thread),
        }
    }

    /// Register a channel before initialization completes, so a dedicated
    /// channel sees every frame live (`attach`, `:302`).
    pub fn attach(
        &self,
        tenant: u64,
        handlers: Arc<dyn ChannelHandlers>,
    ) -> Result<Vec<HostEffect>, HostError> {
        let mut inner = self.lock();
        if inner.exit.is_some() || inner.retiring {
            return Err(HostError::Unavailable);
        }
        if inner.config.dedicated && !inner.tenants.is_empty() {
            return Err(HostError::DedicatedInUse);
        }
        inner.cancel_idle();
        inner.tenants.insert(
            tenant,
            Tenant {
                handlers,
                closed: None,
                muted: false,
                exited: false,
            },
        );
        // The handshake's frames reached the process before this channel was
        // registered: replay them so a dedicated channel still sees them.
        let init: Vec<(Direction, Value)> = inner.init_frames.clone();
        for (dir, data) in init {
            inner.deliver(tenant, dir, &data, None);
        }
        match inner.ready.clone() {
            Handshake::Open => inner.out.push(HostEffect::Opened { tenant }),
            Handshake::Failed(message) => inner.fail_tenant(tenant, &message),
            Handshake::Initializing => {}
        }
        Ok(inner.take())
    }

    /// A channel's request, written through the shared peer (`send`, `:331`).
    pub fn request(
        &self,
        tenant: u64,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
    ) -> Result<Vec<HostEffect>, HostError> {
        let mut inner = self.lock();
        // A channel that left, or is leaving, issues nothing (`host.ts:153`).
        let closed = match inner.tenants.get(&tenant) {
            _ if inner.detaching.contains_key(&tenant) => Some("Codex channel closed".to_owned()),
            Some(entry) => entry.closed.clone(),
            None => Some("Codex channel closed".to_owned()),
        };
        if let Some(closed) = closed {
            return Err(HostError::Refused(closed));
        }
        inner.sender = Some(tenant);
        let requested = inner.peer.request(method, params, id, timeout);
        match requested {
            // The send frame is attributed while the sender is still known.
            Ok(peer) => {
                inner.calls.insert(id, tenant);
                inner.apply(peer);
            }
            Err(error) => {
                inner.sender = None;
                return Err(HostError::Refused(error.message().to_owned()));
            }
        }
        inner.sender = None;
        Ok(inner.take())
    }

    /// A session's answer to a server request (`answer`).
    pub fn answer(&self, id: &RpcId, result: &Value) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.answer(id, result);
        inner.apply(peer);
        inner.take()
    }

    /// A session's refusal of a server request.
    pub fn answer_error(&self, id: &RpcId, code: f64, message: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.answer_error(id, code, message);
        inner.apply(peer);
        inner.take()
    }

    /// One framed stdout line (`#received`).
    pub fn line(&self, line: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.line(line);
        inner.apply(peer);
        inner.take()
    }

    /// One stderr line: diagnostics, to every channel.
    pub fn stderr_line(&self, line: &str) {
        let inner = self.lock();
        for entry in inner.tenants.values() {
            entry.handlers.stderr(line);
        }
    }

    /// The write callback ran: release its bytes and hand out the next line.
    pub fn written(&self, ticket: u64) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.written(ticket);
        inner.apply(peer);
        inner.take()
    }

    /// An armed deadline fired.
    pub fn timer(&self, key: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if key == IDLE_TIMER {
            inner.idle_armed = false;
            if inner.tenants.is_empty() {
                inner.retire(Retirement::Idle, false);
            }
            return inner.take();
        }
        let peer = inner.peer.timer(key);
        inner.apply(peer);
        inner.take()
    }

    /// A line the framing layer dropped, attributed by the adapter.
    pub fn dropped(&self, line: &DroppedLine) -> Vec<HostEffect> {
        let mut inner = self.lock();
        inner.dropped(line);
        inner.take()
    }

    /// The leader exited (`exit`, `:268`): the status is recorded and every
    /// routed call still pending settles exactly once, but the channels stay
    /// until the pipes are done, so the frames after the leader reach them.
    pub fn exit(&self, exit: RawExit) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if inner.leader.is_some() {
            return inner.take();
        }
        inner.exiting = true;
        inner.gate.drain();
        let stopped = inner.peer.stop_requests("process exited");
        inner.apply(stopped);
        let exit = HostExit::from_raw(exit, inner.pid, inner.output_drained);
        inner.leader = Some(exit);
        inner.lead_retired();
        inner.take()
    }

    /// The pipes are done (`close`, `:239`): settlements, then the held
    /// requests, then the exit to every channel.
    pub fn closed(&self, exit: RawExit) -> Vec<HostEffect> {
        let mut inner = self.lock();
        inner.exiting = true;
        inner.gate.drain();
        let closed = inner.peer.close("process exited");
        inner.apply(closed);
        let leader = inner
            .leader
            .clone()
            .unwrap_or_else(|| HostExit::from_raw(exit, inner.pid, true));
        let exit = HostExit {
            output_drained: inner.output_drained,
            ..leader
        };
        if inner.exit.is_none() {
            inner.exited(exit);
        }
        inner.take()
    }

    /// The final drain was cut short, so the exit reports `outputDrained: false`.
    pub fn output_cut(&self) {
        self.lock().output_drained = false;
    }

    /// Stop routing to this channel (`detach`, `:346`). It issues nothing new,
    /// interrupts the turns it still runs, and keeps receiving its threads'
    /// frames until its unsubscribes land.
    pub fn detach(&self, tenant: u64, retirement: Retirement, reason: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if inner.detaching.contains_key(&tenant)
            || inner
                .tenants
                .get(&tenant)
                .is_none_or(|entry| entry.closed.is_some())
        {
            return inner.take();
        }
        // Every call this channel waits on settles now (`tenant.abort`,
        // `host.ts:349`): a call with no deadline never outlives its channel.
        inner.abort_calls(tenant, reason);
        if inner.config.dedicated || inner.exiting {
            // A dedicated process belongs to this channel; its exit is the
            // channel's exit, published when the pipes are done.
            inner.retire(retirement, true);
            return inner.take();
        }
        // A running turn cannot outlive its channel: the interrupt goes out
        // while the channel still owns its threads, so its completion lands in
        // the channel's queue before the exit. The threads are released once
        // every interrupt is answered, as the session's close awaits them.
        let interrupts = inner.interrupt_turns(tenant);
        inner.detaching.insert(
            tenant,
            Detaching {
                remaining: interrupts,
                retirement,
                phase: Leaving::Interrupts,
            },
        );
        if interrupts == 0 {
            inner.unsubscribe_threads(tenant);
        }
        inner.take()
    }

    /// Stop the whole process (`retire`, `:379`); every channel on it exits.
    pub fn retire(&self, reason: Retirement) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if inner.retiring && inner.exit.is_none() {
            // The stop in flight is the shell's: its failure reaches this
            // caller too.
            inner.out.push(HostEffect::Retiring { reason });
            return inner.take();
        }
        inner.retire(reason, true);
        inner.take()
    }

    /// The shell's stop did not confirm: a host that outlived it takes
    /// backpressure again.
    pub fn stop_failed(&self) {
        self.lock().gate.undrain();
    }

    /// A tenant's `outputFlow` pause (`setPaused`).
    pub fn set_paused(&self, tenant: u64, paused: bool) {
        self.gate.set_paused(tenant, paused);
    }

    pub fn paused(&self) -> bool {
        self.gate.paused()
    }

    /// A chunk arrived: answer it while the gate decides.
    pub fn answer_delivery(&self, delivered: Delivered) {
        self.gate.answer(delivered);
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl Inner {
    fn take(&mut self) -> Vec<HostEffect> {
        std::mem::take(&mut self.out)
    }

    /// A facade id for one of the host's own requests.
    fn own_id(&mut self) -> u64 {
        let id = OWN_ID_BASE + self.next_own;
        self.next_own += 1;
        id
    }

    /// An own request, with no tenant attributed to its send frame.
    fn own_request(
        &mut self,
        method: &str,
        params: &[(&str, &JsString)],
        timeout_ms: f64,
    ) -> Option<u64> {
        let mut map = Map::with_capacity(params.len());
        for (name, value) in params {
            map.insert(*name, Value::from((*value).clone()));
        }
        let id = self.own_id();
        self.sender = None;
        let peer = self
            .peer
            .request(
                method,
                Some(&Value::Object(map)),
                id,
                Timeout::After(timeout_ms),
            )
            .ok()?;
        self.apply(peer);
        Some(id)
    }

    /// `onRetired` when the leader ends (`#exited`'s first line): the pool
    /// forgets the host while its pipes finish.
    fn lead_retired(&mut self) {
        if self.retired {
            return;
        }
        self.retired = true;
        self.out.push(HostEffect::Retired);
    }

    /// The turns this channel is still running, by thread.
    fn live_turns(&self, tenant: u64) -> Vec<(JsString, JsString)> {
        self.active
            .iter()
            .filter(|(thread, _)| self.router.owner(thread) == Some(&tenant))
            .map(|(thread, turn)| (thread.clone(), turn.clone()))
            .collect()
    }

    /// A close's `turn/interrupt` for every turn the channel still runs
    /// (`session.ts`'s close, `session-commands.ts`). Answers how many were
    /// sent, so the release waits for them.
    fn interrupt_turns(&mut self, tenant: u64) -> usize {
        let mut sent = 0;
        for (thread, _turn) in self.live_turns(tenant) {
            if let Some(id) =
                self.own_request("turn/interrupt", &[("threadId", &thread)], INTERRUPT_MS)
            {
                self.own.insert(id, OwnPurpose::Interrupt { tenant });
                sent += 1;
            }
        }
        sent
    }

    /// One interrupt answered: the last one releases the channel's threads and
    /// unsubscribes them (`detach`, `:356`).
    fn interrupt_answered(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        if state.phase != Leaving::Interrupts {
            return;
        }
        state.remaining = state.remaining.saturating_sub(1);
        if state.remaining == 0 {
            self.unsubscribe_threads(tenant);
        }
    }

    /// Each of the channel's threads is unsubscribed (`:356`); they stay its
    /// own until the last one lands, so the frames their interrupts produce
    /// still reach the channel.
    fn unsubscribe_threads(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        state.phase = Leaving::Unsubscribes;
        let retirement = state.retirement;
        let threads = self.router.owned(&tenant);
        let mut issued = 0;
        for thread in &threads {
            if let Some(id) = self.own_request(
                "thread/unsubscribe",
                &[("threadId", thread)],
                UNSUBSCRIBE_MS,
            ) {
                self.own.insert(id, OwnPurpose::Unsubscribe { tenant });
                issued += 1;
            }
        }
        if issued == 0 {
            // Nothing could be asked: the channel still leaves.
            self.channel_detached(tenant, retirement);
            return;
        }
        if let Some(state) = self.detaching.get_mut(&tenant) {
            state.remaining = issued;
        }
    }

    /// Keep each thread's running turn, so a close can interrupt it.
    fn track_active(&mut self, message: &Value) {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        if method != "turn/started" && method != "turn/completed" {
            return;
        }
        let Some(thread) = super::routing::subject_thread(message) else {
            return;
        };
        let Some(turn) = message
            .get("params")
            .and_then(|params| params.get("turn"))
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
        else {
            return;
        };
        let turn = JsString::from(turn);
        if method == "turn/started" {
            self.active.insert(thread, turn);
        } else if self.active.get(&thread) == Some(&turn) {
            self.active.shift_remove(&thread);
        }
    }

    /// Settle every call one channel is waiting on (`tenant.abort`,
    /// `host.ts:349`), settling the peer's promise exactly as a reply would.
    fn abort_calls(&mut self, tenant: u64, reason: &str) {
        let calls: Vec<u64> = self
            .calls
            .iter()
            .filter(|(_, owner)| **owner == tenant)
            .map(|(id, _)| *id)
            .collect();
        for id in calls {
            self.calls.shift_remove(&id);
            let effects = self.peer.abort(id, reason);
            self.apply(effects);
        }
    }

    /// Apply the peer's effects in order, dispatching the ones the host owns.
    fn apply(&mut self, effects: Vec<PeerEffect>) {
        let mut pending: Option<Pending> = None;
        for effect in effects {
            match effect {
                PeerEffect::Frame {
                    dir: Direction::Send,
                    value,
                } => {
                    if let Some(message) = self.sent(&value) {
                        self.report_all(&message);
                    }
                }
                PeerEffect::Frame {
                    dir: Direction::Recv,
                    value,
                } => pending = Some(self.received(value)),
                PeerEffect::Notification { method, params } => {
                    self.notification(pending.take(), &method, params.as_ref());
                }
                PeerEffect::ServerRequest { id, method, params } => {
                    self.server_request(pending.take(), id, &method, params.as_ref());
                }
                PeerEffect::Malformed { line } => {
                    let tenants: Vec<(u64, Arc<dyn ChannelHandlers>)> = self
                        .tenants
                        .iter()
                        .map(|(id, entry)| (*id, Arc::clone(&entry.handlers)))
                        .collect();
                    for (_, handlers) in tenants {
                        handlers.malformed(&line);
                    }
                }
                PeerEffect::Settle { id, result } => self.settle(id, result),
                PeerEffect::Write { wire, ticket } => {
                    self.out.push(HostEffect::Write { wire, ticket })
                }
                PeerEffect::ArmTimer { key, ms } => self.out.push(HostEffect::ArmTimer { key, ms }),
                PeerEffect::CancelTimer { key } => self.out.push(HostEffect::CancelTimer { key }),
                PeerEffect::Failed { message } => self.report_all(&message),
            }
        }
    }

    /// An outgoing frame: a tenant's own, its answer, or an init frame to
    /// everyone (`#sent`, `:437`).
    fn sent(&mut self, data: &Value) -> Option<String> {
        let sender = self.sender;
        let tenant = self.router.sent(data, sender.as_ref());
        if let Some(tenant) = tenant {
            let mut failed = None;
            if !self.deliver(tenant, Direction::Send, data, Some(&mut failed)) {
                return failed.or_else(|| Some("Codex send frame was not admitted".to_owned()));
            }
            return None;
        }
        let method = data.get("method").and_then(Value::as_str)?;
        if method == "initialize" {
            self.initialize_id = id_of(data);
        }
        if method == "initialize" || method == "initialized" {
            self.broadcast_init(Direction::Send, data);
        }
        None
    }

    /// Init frames are replayed to every tenant that attaches (`:449`).
    fn broadcast_init(&mut self, dir: Direction, data: &Value) {
        self.init_frames.push((dir, data.clone()));
        for tenant in self.tenant_ids() {
            self.deliver(tenant, dir, data, None);
        }
    }

    /// Where a received message goes, with the dedicated and lone-channel
    /// overrides (`#route`, `:454`).
    fn route(&mut self, data: &Value) -> Route<u64> {
        let route = self.router.received(data);
        let only = self.tenants.keys().next().copied();
        let alone = self.tenants.len() == 1;
        if self.config.dedicated && route != Route::Host {
            return match only {
                Some(tenant) => Route::Tenant {
                    tenant,
                    claimed: Vec::new(),
                },
                None => Route::Drop,
            };
        }
        if matches!(route, Route::Hold { .. })
            && let Some(tenant) = only
            && alone
        {
            return Route::Tenant {
                tenant,
                claimed: Vec::new(),
            };
        }
        route
    }

    /// One received frame (`#received`, `:495`).
    fn received(&mut self, data: Value) -> Pending {
        let route = self.route(&data);
        let mut pending = Pending {
            route: route.clone(),
            data: None,
            held: None,
            failed: HashSet::new(),
        };
        match route {
            Route::Host => {
                if id_of(&data) == self.initialize_id {
                    self.broadcast_init(Direction::Recv, &data);
                }
                pending.data = Some(data);
            }
            Route::Drop => {}
            Route::Hold { thread } => {
                pending.held = self.hold(thread, &data);
                pending.data = Some(data);
            }
            Route::All => {
                for tenant in self.tenant_ids() {
                    if !self.deliver(tenant, Direction::Recv, &data, None) {
                        pending.failed.insert(tenant);
                    }
                }
            }
            Route::Tenant { tenant, claimed } => {
                for thread in claimed {
                    self.claimed(&thread, tenant);
                }
                if !self.deliver(tenant, Direction::Recv, &data, None) {
                    pending.failed.insert(tenant);
                }
                self.track_active(&data);
                if self.router.opening() == 0 {
                    self.settle_waiting();
                }
            }
        }
        pending
    }

    /// A notification follows its frame; a held one is dispatched on release
    /// (`#notification`, `:521`).
    fn notification(
        &mut self,
        pending: Option<Pending>,
        method: &JsString,
        params: Option<&Value>,
    ) {
        let Some(pending) = pending else {
            return;
        };
        if let Some((thread, index)) = &pending.held {
            if let Some(hold) = self.holds.get_mut(thread)
                && let Some(item) = hold.items.get_mut(*index)
            {
                let data = item.data().clone();
                *item = Held::Notification {
                    data,
                    method: method.clone(),
                    params: params.cloned(),
                };
            }
            return;
        }
        match pending.route {
            Route::Tenant { tenant, .. } => {
                if !pending.failed.contains(&tenant)
                    && let Some(entry) = self.tenants.get(&tenant)
                {
                    entry.handlers.notification(method, params);
                }
            }
            Route::All => {
                for tenant in self.tenant_ids() {
                    if pending.failed.contains(&tenant) {
                        continue;
                    }
                    if let Some(entry) = self.tenants.get(&tenant) {
                        entry.handlers.notification(method, params);
                    }
                }
            }
            _ => {}
        }
    }

    /// A server request follows its frame; it is answered once, by its owner
    /// (`#request`, `:537`).
    fn server_request(
        &mut self,
        pending: Option<Pending>,
        id: RpcId,
        method: &JsString,
        params: Option<&Value>,
    ) {
        let Some(pending) = pending else {
            self.refuse(&id, "unhandled request");
            return;
        };
        if let Some((thread, index)) = &pending.held {
            if let Some(hold) = self.holds.get_mut(thread)
                && let Some(item) = hold.items.get_mut(*index)
            {
                let data = item.data().clone();
                *item = Held::Request {
                    data,
                    id,
                    method: method.clone(),
                    params: params.cloned(),
                };
            }
            return;
        }
        match &pending.route {
            Route::Tenant { tenant, .. } if !pending.failed.contains(tenant) => {
                self.serve(&id, *tenant, method, params);
            }
            Route::Host if self.tenants.len() == 1 => {
                let tenant = self.tenants.keys().next().copied().unwrap_or_default();
                // A request naming no thread or turn can only be answered when
                // one session could own it: it sees the frame its discovery
                // needs, then answers it.
                if let Some(data) = &pending.data {
                    self.deliver(tenant, Direction::Recv, data, None);
                }
                self.serve(&id, tenant, method, params);
            }
            _ => self.refuse(&id, &format!("Unsupported Codex request: {method}")),
        }
    }

    /// Answer a request nobody can own, as `MethodNotFound`.
    fn refuse(&mut self, id: &RpcId, message: &str) {
        let peer = self.peer.answer_error(id, METHOD_NOT_FOUND, message);
        self.apply(peer);
    }

    /// Hand a server request to one tenant, then answer it.
    fn serve(&mut self, id: &RpcId, tenant: u64, method: &JsString, params: Option<&Value>) {
        self.router.serve(id.clone(), tenant);
        let Some(entry) = self.tenants.get(&tenant) else {
            self.refuse(id, "Codex request has no ace owner");
            return;
        };
        let answer = entry.handlers.request(id, method, params);
        match answer {
            RequestAnswer::Answered(value) => {
                let peer = self.peer.answer(id, &value);
                self.apply(peer);
            }
            RequestAnswer::MethodNotFound(message) => {
                let peer = self.peer.answer_error(id, METHOD_NOT_FOUND, &message);
                self.apply(peer);
            }
            RequestAnswer::Failed(message) => {
                let peer = self.peer.answer_error(id, INTERNAL_ERROR, &message);
                self.apply(peer);
            }
            RequestAnswer::Deferred => {}
        }
    }

    /// Deliver one frame to one tenant (`Tenant.deliver`, `:169`).
    fn deliver(
        &mut self,
        tenant: u64,
        dir: Direction,
        data: &Value,
        failed: Option<&mut Option<String>>,
    ) -> bool {
        let Some(entry) = self.tenants.get_mut(&tenant) else {
            return false;
        };
        if entry.closed.is_some() || entry.muted {
            return false;
        }
        let handlers = Arc::clone(&entry.handlers);
        match handlers.frame(dir, data) {
            Admission::Taken => true,
            Admission::Failed(message) => {
                entry.muted = true;
                handlers.failed(&message);
                if let Some(failed) = failed {
                    *failed = Some(message);
                }
                false
            }
        }
    }

    fn tenant_ids(&self) -> Vec<u64> {
        self.tenants.keys().copied().collect()
    }

    fn report_all(&self, message: &str) {
        for entry in self.tenants.values() {
            entry.handlers.error(message);
        }
    }

    /// A supervisor drop: answer the request it lost, then tell the channel
    /// that owns the thread (`#dropped`, `:466`).
    fn dropped(&mut self, line: &DroppedLine) {
        let mut rejected = false;
        if line.phase != DroppedPhase::End
            && let Some(id) = &line.response
        {
            let message = dropped_message(line.bytes);
            let peer = self
                .peer
                .reject_request(id, PeerError::new(message.clone()));
            if !peer.is_empty() {
                rejected = true;
                self.apply(peer);
                // Follow normal reply routing to clear request ownership and
                // session correlation too.
                let reply = ace_json::json!({
                    "id": id_to_value(id),
                    "error": {"code": -32099.0, "message": message},
                });
                let _ = self.received(reply);
                if self.router.opening() == 0 {
                    self.settle_waiting();
                }
            }
        }
        let affected = match &line.thread {
            Some(thread) => match self.router.owner(thread).copied() {
                Some(owner) => vec![owner],
                None => self.tenant_ids(),
            },
            None => self.tenant_ids(),
        };
        for tenant in affected {
            let Some(entry) = self.tenants.get(&tenant) else {
                continue;
            };
            if entry.closed.is_some() {
                continue;
            }
            if line.phase != DroppedPhase::End && !rejected {
                entry.handlers.output_uncertain();
            }
            entry.handlers.dropped(line);
        }
    }

    /// A request the host made itself: its answer goes back into the walk.
    fn settle(&mut self, id: u64, result: Result<Value, PeerError>) {
        if id == self.initialize_call {
            self.initialized(&result);
            return;
        }
        let Some(purpose) = self.own.remove(&id) else {
            self.calls.shift_remove(&id);
            self.out.push(HostEffect::Settle { id, result });
            return;
        };
        match purpose {
            OwnPurpose::Read { thread, hold } => self.read_settled(&thread, hold, result),
            OwnPurpose::Unsubscribe { tenant } => self.unsubscribed(tenant),
            OwnPurpose::Interrupt { tenant } => self.interrupt_answered(tenant),
        }
    }

    /// One of a detached channel's unsubscribes landed.
    fn unsubscribed(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        state.remaining = state.remaining.saturating_sub(1);
        if state.remaining > 0 {
            return;
        }
        let Some(state) = self.detaching.shift_remove(&tenant) else {
            return;
        };
        self.channel_detached(tenant, state.retirement);
    }

    /// The `initialize` handshake's answer.
    fn initialized(&mut self, result: &Result<Value, PeerError>) {
        match result {
            Ok(_) => {
                match self.peer.notify("initialized", None) {
                    Ok(peer) => self.apply(peer),
                    Err(error) => self.report_all(error.message()),
                }
                self.ready = Handshake::Open;
                for tenant in self.tenant_ids() {
                    self.out.push(HostEffect::Opened { tenant });
                }
            }
            Err(error) => {
                let message = error.message().to_owned();
                self.ready = Handshake::Failed(message.clone());
                let tenants = self.tenant_ids();
                for tenant in tenants {
                    self.fail_tenant(tenant, &message);
                }
                self.vacated(false);
            }
        }
    }

    /// A tenant that cannot open: forget it and let the host idle (`attach`'s
    /// catch).
    fn fail_tenant(&mut self, tenant: u64, message: &str) {
        if let Some(entry) = self.tenants.get_mut(&tenant) {
            entry.closed = Some(message.to_owned());
            entry.exited = true;
        }
        self.tenants.shift_remove(&tenant);
        self.gate.release(tenant);
        self.router.release(&tenant);
        self.out.push(HostEffect::OpenFailed {
            tenant,
            message: message.to_owned(),
        });
        self.vacated(false);
    }

    /// A host with no channels stays up for the next session, or stops now
    /// (`#vacated`, `:398`).
    fn vacated(&mut self, now: bool) {
        if !self.tenants.is_empty() || self.exit.is_some() || self.retiring {
            return;
        }
        if self.config.dedicated || now {
            self.retire(Retirement::Idle, true);
            return;
        }
        self.cancel_idle();
        if self.config.idle_ms.is_finite() && self.config.idle_ms >= 0.0 {
            self.idle_armed = true;
            self.out.push(HostEffect::ArmTimer {
                key: IDLE_TIMER.to_owned(),
                ms: self.config.idle_ms,
            });
        }
    }

    /// The idle deadline is cancelled by an attach, an exit or a retire.
    fn cancel_idle(&mut self) {
        if !self.idle_armed {
            return;
        }
        self.idle_armed = false;
        self.out.push(HostEffect::CancelTimer {
            key: IDLE_TIMER.to_owned(),
        });
    }

    /// Stop the whole process (`retire`, `:379`): `onRetired` runs once, then
    /// the shell stops the child.
    fn retire(&mut self, reason: Retirement, awaited: bool) {
        if self.retiring || self.exit.is_some() {
            return;
        }
        self.cancel_idle();
        if !self.retired {
            self.retired = true;
            self.out.push(HostEffect::Retired);
        }
        self.retiring = true;
        // A close started: a paused channel must not hold the drain.
        self.gate.drain();
        self.out.push(HostEffect::Retire { reason, awaited });
    }

    /// A detached channel's exit, once its unsubscribes landed (`detach`,
    /// `:360`).
    fn channel_detached(&mut self, tenant: u64, retirement: Retirement) {
        self.detaching.shift_remove(&tenant);
        let Some(mut entry) = self.tenants.shift_remove(&tenant) else {
            return;
        };
        self.gate.release(tenant);
        self.router.release(&tenant);
        self.active
            .retain(|thread, _| self.router.owner(thread).is_some());
        if entry.exited {
            return;
        }
        entry.exited = true;
        let exit = HostExit {
            reason: ExitReason::Detached,
            code: None,
            signal: None,
            pid: self.pid,
            output_drained: true,
        };
        self.out.push(HostEffect::Exited { tenant, exit });
        self.vacated(retirement == Retirement::Shutdown);
    }

    /// The pipes are done (`#exited`, `:416`): settlements were published
    /// first (`closed`), then the held requests are answered and every channel
    /// hears its exit once.
    fn exited(&mut self, exit: HostExit) {
        if self.exit.is_some() {
            return;
        }
        self.exit = Some(exit.clone());
        self.cancel_idle();
        self.lead_retired();
        self.detaching.clear();
        self.calls.clear();
        self.active.clear();
        let holds: Vec<Hold> = self.holds.drain(..).map(|(_, hold)| hold).collect();
        for hold in holds {
            for item in &hold.items {
                self.dispatch_none(item);
            }
        }
        let tenants: Vec<(u64, Tenant)> = self.tenants.drain(..).collect();
        for (tenant, mut entry) in tenants {
            self.gate.release(tenant);
            entry
                .closed
                .get_or_insert_with(|| "process exited".to_owned());
            if !entry.exited {
                entry.exited = true;
                self.out.push(HostEffect::Exited {
                    tenant,
                    exit: exit.clone(),
                });
            }
        }
    }
}

fn id_of(data: &Value) -> Option<RpcId> {
    match data.get("id") {
        Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
        Some(Value::Number(number)) => number.as_f64().map(RpcId::Number),
        _ => None,
    }
}

fn id_to_value(id: &RpcId) -> Value {
    match id {
        RpcId::Text(text) => Value::String(text.clone()),
        RpcId::Number(number) => Value::from(*number),
    }
}

#[cfg(test)]
mod tests;
