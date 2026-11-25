// SPDX-License-Identifier: Apache-2.0
//! One Codex session's state and callbacks (`session.ts:73`-`:124` and
//! `:392`-`:405`): every map the frame handler keeps, the notification and
//! server-request callbacks, and the frame handler itself in `state/frame.rs`.
//! The frame's redaction and bound are `frames.rs`; discovery, lifetime, tools
//! and terminals keep the rest.
//!
//! Every method returns the effects its input produced, in the order its state
//! changed, so the shell publishes a frame only after the state change it
//! belongs to (ADR 0223 section 7 rule 3).

use std::collections::{HashSet, VecDeque};

use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::Direction;
use indexmap::{IndexMap, IndexSet};

use super::discovery::Discovery;
use super::frames::{Calls, Effect, FrameDir, Frames};
use super::host::Admission;
use super::lifetime::{Lifetime, Redactor};
use crate::translate::helpers::is_async_question;
use crate::translate::retention::RecentSet;

mod callbacks;
mod frame;

#[cfg(test)]
mod tests;

/// At most 256 recovery timers a session arms (`session.ts:277`).
pub(crate) const TIMER_LIMIT: usize = 256;
/// Closed shell ids kept as replay hints (`completedShells`, `:299`).
pub(crate) const COMPLETED_SHELLS: usize = 1024;
/// One control request's correlation deadline (`awaitCorrelation`, `:92`).
pub(crate) const CORRELATION_MS: f64 = 30_000.0;

/// One started control request (`controlRequests`, `:88`).
pub(crate) struct ControlRequest {
    pub method: String,
    pub thread: String,
    pub mode: Option<String>,
    /// Turns this request's thread already saw complete (`RecentSet`).
    pub completed: RecentSet,
    /// History follows in bounded pages instead of in this reply (#693).
    pub excludes_turns: bool,
}

/// A server request waiting for a human (`pending`, `:108`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Pending {
    pub id: RpcId,
    pub method: JsString,
    pub params: Option<Value>,
}

/// A question Codex delivered asynchronously, for the interaction layer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AsyncQuestion {
    pub thread: String,
    /// The native `questions` array, as the item carried it.
    pub questions: Value,
}

/// A plan item an active turn produced (`plans`, `:114`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Plan {
    pub thread: String,
    pub markdown: String,
}

/// `link.foreign(threadId)`: the thread belongs to another session on a shared
/// app-server. The host router answers it; a dedicated host never does.
pub type Foreign = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// A set with `completedShells`' discipline: an id added twice keeps its first
/// place, and the oldest goes once the bound is passed.
#[derive(Debug, Default)]
pub(crate) struct BoundedSet {
    order: VecDeque<String>,
    present: HashSet<String>,
}

impl BoundedSet {
    pub(crate) fn insert(&mut self, value: String) {
        if !self.present.insert(value.clone()) {
            return;
        }
        self.order.push_back(value);
        while self.order.len() > COMPLETED_SHELLS {
            if let Some(oldest) = self.order.pop_front() {
                self.present.remove(&oldest);
            }
        }
    }

    pub(crate) fn contains(&self, value: &str) -> bool {
        self.present.contains(value)
    }
}

/// A control request's correlation deadline (`correlationDeadlines`, `:94`).
pub(crate) struct Correlation {
    pub id: RpcId,
    pub deadline: f64,
    pub thread: String,
}

/// What `Session::new` needs from the facade's injected runtime.
pub struct SessionConfig {
    /// `io.sessionId()`: the generation and the interaction key's scope.
    pub scope: String,
    /// `io.now()` at open.
    pub started: f64,

    /// The ace MCP bearer, for `redactMcpCredential`.
    pub bearer: Option<String>,
    /// The `@ace/redaction` text redactor the stderr path scrubs with.
    pub redact: Redactor,
    /// `link.foreign(thread)`.
    pub foreign: Foreign,
}

/// One session's state. Created when the channel opens; every input is a
/// method here or on the module beside it.
pub struct Session {
    pub(crate) scope: String,
    pub(crate) started: f64,
    /// `nativeSessionId`: the root thread, empty until it is known.
    pub(crate) root: String,
    pub(crate) frames: Frames,
    pub(crate) calls: Calls,
    pub(crate) lifetime: Lifetime,
    pub(crate) discovery: Discovery,
    pub(crate) foreign: Foreign,
    pub(crate) permission_mode: Option<String>,
    pub(crate) applied_permission_mode: Option<String>,
    /// `active`: each thread's running turn.
    pub(crate) active: IndexMap<String, String>,
    pub(crate) control_requests: IndexMap<RpcId, ControlRequest>,
    /// Each correlated request's deadline and thread, by its timer key.
    pub(crate) correlations: IndexMap<String, Correlation>,
    /// `revisions`: how many control-relevant frames a thread has seen.
    pub(crate) revisions: IndexMap<String, u64>,
    pub(crate) reading: IndexSet<String>,
    pub(crate) scoped_reads: IndexSet<RpcId>,
    pub(crate) parents: IndexMap<String, String>,
    pub(crate) known: IndexSet<String>,
    pub(crate) ended_turns: RecentSet,
    pub(crate) history_replies: IndexSet<RpcId>,
    pub(crate) recovered: IndexSet<String>,
    /// `shells`: each running command item and the thread it belongs to.
    pub(crate) shells: IndexMap<String, String>,
    pub(crate) completed_shells: BoundedSet,
    pub(crate) pending: IndexMap<String, Pending>,
    pub(crate) async_questions: IndexMap<String, AsyncQuestion>,
    pub(crate) plans: IndexMap<String, Plan>,
    /// The timers this session armed, by their one key (`timers`, `:115`).
    pub(crate) timers: IndexMap<String, ()>,
    pub(crate) seen_questions: IndexSet<String>,
}

impl Session {
    pub fn new(config: SessionConfig) -> Session {
        let generation = config.scope.clone();
        Session {
            scope: config.scope,
            started: config.started,
            root: String::new(),
            frames: Frames::new(config.bearer.clone()),
            calls: Calls::new(),
            lifetime: Lifetime::new(generation, config.redact, config.bearer),
            discovery: Discovery::new(),
            foreign: config.foreign,
            permission_mode: None,
            applied_permission_mode: None,
            active: IndexMap::new(),
            control_requests: IndexMap::new(),
            correlations: IndexMap::new(),
            revisions: IndexMap::new(),
            reading: IndexSet::new(),
            scoped_reads: IndexSet::new(),
            parents: IndexMap::new(),
            known: IndexSet::new(),
            ended_turns: RecentSet::new(),
            history_replies: IndexSet::new(),
            recovered: IndexSet::new(),
            shells: IndexMap::new(),
            completed_shells: BoundedSet::default(),
            pending: IndexMap::new(),
            async_questions: IndexMap::new(),
            plans: IndexMap::new(),
            timers: IndexMap::new(),
            seen_questions: IndexSet::new(),
        }
    }

    /// `lifetime.attached(link)`: the channel is open and the root is known.
    pub fn attached(&mut self, root: &str, shared: bool, alone: bool) -> Vec<Effect> {
        self.root = root.to_owned();
        self.known.insert(root.to_owned());
        if shared {
            self.frames.attach_shared();
        }
        self.lifetime.attached(shared, alone);
        Vec::new()
    }

    pub fn is_closed(&self) -> bool {
        self.lifetime.is_closed()
    }

    /// `started`: the frame clock's origin, which the bridge subtracts.
    pub fn started(&self) -> f64 {
        self.started
    }

    /// `assertOpen`: commands refuse once the session is closed.
    pub fn assert_open(&self) -> Result<(), String> {
        if self.lifetime.is_closed() {
            return Err("Codex session is closed".to_owned());
        }
        Ok(())
    }

    /// `busy()`: live turns or shells anywhere in this session's tree
    /// (`session.ts:413`).
    pub fn busy(&self) -> bool {
        !self.active.is_empty() || !self.shells.is_empty() || self.discovery.output_uncertain()
    }

    /// The handler's `admit`: a server request the frame bound refuses is
    /// refused here, before the host dispatches it, so no interaction waits
    /// unseen. Every other frame is admitted and `emit` decides it.
    pub fn admit(&self, dir: Direction, data: &Value) -> Admission {
        let dir = match dir {
            Direction::Send => FrameDir::Send,
            Direction::Recv => FrameDir::Recv,
        };
        match self.frames.undispatchable(dir, data) {
            Some(message) => Admission::Failed(message),
            None => Admission::Taken,
        }
    }
}

/// `str(value, "")`.
pub(crate) fn text_of(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_js_str)
        .map(|text| text.as_str().to_owned())
        .unwrap_or_default()
}

/// `String.prototype.length`: UTF-16 code units, as every zod `.max()` bound
/// counts them and as JavaScript's `slice` does.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `turn.id` from a notification's params.
pub(crate) fn turn_of(params: &Map) -> String {
    text_of(
        params
            .get("turn")
            .and_then(Value::as_object)
            .and_then(|turn| turn.get("id")),
    )
}

/// One message id, when it is one (`isRpcId`).
pub(crate) fn rpc_of(value: Option<&Value>) -> RpcId {
    match value {
        Some(Value::String(text)) => RpcId::Text(text.clone()),
        Some(Value::Number(number)) => RpcId::Number(number.as_f64().unwrap_or(0.0)),
        _ => RpcId::Text(JsString::from("")),
    }
}

/// The timer key of one correlated request.
pub(crate) fn correlation_key(id: &RpcId) -> Option<String> {
    match id {
        RpcId::Text(text) => Some(format!("correlation:{}", text.as_str())),
        RpcId::Number(number) => Some(format!("correlation:{number}")),
    }
}

/// `valueOf(id)`: an id back as the value a key is built from.
pub(crate) fn value_of(id: &RpcId) -> Value {
    match id {
        RpcId::Text(text) => Value::String(text.clone()),
        RpcId::Number(number) => Value::Number(ace_json::Number::from_f64_lossy(*number)),
    }
}

/// `rememberHistoricalQuestions` (`interaction-lifecycle.ts:12`): history
/// establishes transcript identity, never a live answer transport.
pub(crate) fn remember_historical_questions(thread: &Value, seen: &mut IndexSet<String>) {
    let thread = thread.as_object().cloned().unwrap_or_default();
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for turn in turns {
        let items = turn
            .as_object()
            .and_then(|turn| turn.get("items"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item in items {
            if is_async_question(&item) {
                seen.insert(text_of(item.get("id")));
            }
        }
    }
}

/// `hydrateControls` (`session-state.ts:37`): an in-progress turn and its
/// running commands.
pub(crate) fn hydrate_controls(
    thread: &Value,
    active: &mut IndexMap<String, String>,
    shells: &mut IndexMap<String, String>,
    ended: &RecentSet,
) {
    let thread_map = thread.as_object().cloned().unwrap_or_default();
    let id = text_of(thread_map.get("id"));
    let turns = thread_map
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for turn in turns {
        let Some(turn) = turn.as_object() else {
            continue;
        };
        let turn_id = text_of(turn.get("id"));
        if turn.get("status").and_then(Value::as_str) == Some("inProgress") && !ended.has(&turn_id)
        {
            active.insert(id.clone(), turn_id);
        }
        let items = turn
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item in items {
            let Some(item) = item.as_object() else {
                continue;
            };
            if item.get("type").and_then(Value::as_str) == Some("commandExecution")
                && item.get("status").and_then(Value::as_str) == Some("inProgress")
            {
                shells.insert(text_of(item.get("id")), id.clone());
            }
        }
    }
}
