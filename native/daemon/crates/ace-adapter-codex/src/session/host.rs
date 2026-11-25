// SPDX-License-Identifier: Apache-2.0
//! One `codex app-server` process, shared by many ace sessions (`CodexHost`,
//! `host.ts:193`–`:690`). Each session is a *tenant*: a channel that sees only
//! the native threads it opened and their descendants. A tenant is registered
//! before initialization completes, so a dedicated channel sees every frame
//! live; the init frames are replayed to every tenant that attaches.
//!
//! Sans-IO like `PiWire` and `RpcPeer`: every input — a framed stdout line, a
//! stderr line, a write acknowledgement, a timer, a detach — runs one method
//! under this host's lock and publishes its effects, in the order the state
//! changed. Publication is one queue the host fills under its lock and exactly
//! one caller drains into the shell's sink, so two inputs never swap the
//! effects they decided: a settlement a timer decided is never published after
//! the exit a pipe close decided later, and a notification never overtakes the
//! frame it belongs to (ADR 0223 §7 rule 3). Every callback a channel observes
//! is such an effect; the shell hands them over with `Host::hand_over`
//! (`callbacks.rs`). The shell owns the child, its stdin queue and the timers
//! (E3.0b).
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

mod api;
mod callbacks;
mod channels;
mod exit;
mod gate;
mod holds;
mod publication;
mod settlement;
mod stop;

pub use gate::HostGate;
use holds::{Held, Hold};
pub use publication::HostSink;
use publication::Publication;

use std::collections::{HashMap, HashSet, VecDeque};
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
/// A close's background-terminal reads and stops (`stopShells`, `:183`).
const TERMINALS_MS: f64 = 10_000.0;
/// A terminal-list page's bounds (`TerminalPage`, `background-terminals.ts:2`).
const TERMINALS_PER_PAGE: usize = 256;
/// A terminal's `processId` bound.
const TERMINAL_ID_MAX: usize = 1024;
/// A continuation cursor's bound.
const CURSOR_MAX: usize = 4096;
/// A close reads at most 4,096 terminals over at most 64 pages
/// (`readBackgroundTerminals`).
const TERMINAL_TOTAL: usize = 4096;
const TERMINAL_PAGES: usize = 64;
/// The idle deadline's facade key.
pub const IDLE_TIMER: &str = "host:idle";
/// The error every call fails with when a channel callback unwinds: a bug in
/// the shell, not a protocol event (behaviour.md, "A channel callback that
/// unwinds poisons its host").
pub const HOST_FAILED: &str = "Codex host failed: a channel callback unwound";
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
/// calls back into the host: `admit` runs under the host's lock, and `frame`
/// runs in its publisher, in the order the host decided the frames.
pub trait ChannelHandlers: Send + Sync {
    /// Whether this channel takes the frame. Answered under the host's lock,
    /// because the input's control flow depends on it: a refused frame mutes
    /// its channel, and a request whose frame was refused is not dispatched. It
    /// delivers nothing; the frame itself follows as `HostEffect::Frame`, in
    /// the host's publication order.
    fn admit(&self, dir: Direction, data: &Value) -> Admission;
    /// The frame's delivery to the channel, published in the order the host
    /// decided it, alongside every settlement and exit.
    fn frame(&self, dir: Direction, data: &Value);
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
    /// One frame for a channel that took it, published in the host's order
    /// with every settlement and exit. The data is cloned once per delivery.
    Frame {
        tenant: u64,
        dir: Direction,
        data: Value,
    },
    /// One notification, after the frame it belongs to.
    Notification {
        tenant: u64,
        method: JsString,
        params: Option<Value>,
    },
    /// One server request, after the frame it belongs to: the channel answers
    /// it through `Host::answer`/`answer_error`, which keeps the reply in this
    /// order too.
    ServerRequest {
        tenant: u64,
        id: RpcId,
        method: JsString,
        params: Option<Value>,
    },
    /// A frame its channel refused: the channel is muted, and this says why.
    AdmissionFailed {
        tenant: u64,
        message: String,
    },
    /// A dropped output line, and whether the channel's output is uncertain.
    Dropped {
        tenant: u64,
        line: DroppedLine,
        uncertain: bool,
    },
    /// A line the framing layer could not read.
    Malformed {
        tenant: u64,
        line: String,
    },
    /// One diagnostic line from the child.
    Stderr {
        tenant: u64,
        line: String,
    },
    /// The host or its peer failed, as every channel hears it.
    Error {
        tenant: u64,
        message: String,
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
    /// A close that could not stop its turn: the provider refused the
    /// interrupt or never answered, so the channel and its work stay attached.
    DetachFailed {
        tenant: u64,
        reason: Retirement,
        message: String,
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
    /// The shared write queue's byte cap. `None` keeps the peer's default; the
    /// tests lower it to reach a full queue without megabytes of traffic.
    pub max_queued_bytes: Option<usize>,
}

impl HostConfig {
    /// A dedicated host: one channel, stopped with it.
    pub fn dedicated(initialize: Value) -> HostConfig {
        HostConfig {
            dedicated: true,
            initialize,
            idle_ms: 0.0,
            timeout_ms: None,
            max_queued_bytes: None,
        }
    }

    /// A shared host: many channels, kept for `idle_ms` when empty.
    pub fn shared(initialize: Value, idle_ms: f64) -> HostConfig {
        HostConfig {
            dedicated: false,
            initialize,
            idle_ms,
            timeout_ms: None,
            max_queued_bytes: None,
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
            max_queued_bytes: self.max_queued_bytes.unwrap_or(defaults.max_queued_bytes),
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
    /// Why the channel is leaving, so its waiting calls settle with it.
    reason: String,
    /// This detach's number: only the current attempt's replies count, so a
    /// late answer from a failed close never releases a retried one.
    attempt: u64,
    phase: Leaving,
    /// Terminals still to stop, by thread, once each, in the order their pages
    /// listed them. One stop is out at a time (`session-commands.ts:181`).
    stops: VecDeque<(JsString, JsString)>,
    /// A stop is out: the next waits for its answer.
    stopping: bool,
}

/// How far a leaving channel has gone: its turns are interrupted, its
/// background terminals stopped, then its threads released and unsubscribed
/// (`session-commands.ts`'s `interruptOne`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leaving {
    Interrupts,
    Terminals,
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
    Interrupt { tenant: u64, attempt: u64 },
    /// One page of a thread's background terminals, read by a close
    /// (`stopShells`): the scan so far carries the terminals and the cursors
    /// already seen, so every page of one close is read exactly once.
    ShellList {
        tenant: u64,
        attempt: u64,
        thread: JsString,
        scan: ShellScan,
    },
    /// One background terminal's stop (`stopShells`).
    ShellStop { tenant: u64, attempt: u64 },
}

/// A thread's background-terminal scan while a close reads its pages
/// (`readBackgroundTerminals`, `background-terminals.ts:16`).
#[derive(Debug, Clone)]
struct ShellScan {
    terminals: Vec<JsString>,
    cursors: HashSet<JsString>,
    pages: usize,
}

impl ShellScan {
    fn new() -> ShellScan {
        ShellScan {
            terminals: Vec::new(),
            cursors: HashSet::new(),
            pages: 0,
        }
    }
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
    /// Channels that left while the process was dying: their exit is
    /// published with the others at the pipe barrier.
    departed: Vec<u64>,
    /// The leader is gone or the pipes are closing: held frames are answered,
    /// never delivered, as `#exited` does.
    exiting: bool,
    detaching: IndexMap<u64, Detaching>,
    next_own: u64,
    next_hold: u64,
    next_attempt: u64,
    ready: Handshake,
    idle_armed: bool,
    /// A channel callback unwound: the host cannot be trusted with more.
    poisoned: bool,
    out: Vec<HostEffect>,
}

/// One app-server process and every channel on it.
pub struct Host {
    inner: Mutex<Inner>,
    /// Effects already decided and not yet handed to the shell, and the one
    /// caller that hands them over.
    publication: Mutex<Publication>,
    gate: HostGate,
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
