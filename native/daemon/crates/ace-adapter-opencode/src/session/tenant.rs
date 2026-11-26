// SPDX-License-Identifier: Apache-2.0
//! One OpenCode session's per-event state (`session.ts:166`-`:419`): what it
//! owns, the opening buffer, the interaction and execution records, the
//! recovery handlers, and the four answers the facade reads without a crossing.
//!
//! Everything inline in the TypeScript that needs the facade's I/O is a `Port`
//! at its call site: a newly joined child's environment, a `session.moved`
//! refetch, the ancestry lookup (E3-opencode.3), a recovery pass, the catalog's
//! six refreshes and the MCP location's forget. `reconcileNow`'s synchronous
//! recovery start is the facade's to run against the server handle, in the same
//! lock that called here.
//!
//! No clock: frames cross without `t` (the bridge stamps it), and the tenant's
//! translator gets `now = 0.0`.

use ace_adapter_api::bridge::{EventQueue, SessionEvent};
use ace_json::{Value, json};
use indexmap::{IndexMap, IndexSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::translate::Translator;

mod probe;
mod recovery;
mod replies;
mod state;

use super::ancestry::AncestryProbe;
use super::evidence::RecoveryEvidence;
use super::history::HistoryReader;
use super::http::Http;
use super::lookup::Lookup;
use super::ownership::SessionOwnership;
use super::server::TenantError;

/// How many events the opening buffer holds (`session.ts:369`).
const OPENING_EVENTS: usize = 128;
/// Its byte bound.
const OPENING_BYTES: usize = 8 * 1024 * 1024;
/// `this.pending.size >= 1024` (`:388`).
const MAX_PENDING: usize = 1024;
/// `this.waiters.size >= 64` (`:424`).
const MAX_WAITERS: usize = 64;
/// `new Error("OpenCode session closed")` in `shutdown`: a waiting barrier
/// rejects with it (`:557`).
const SESSION_CLOSED: &str = "OpenCode session closed";
/// `barrier`'s own refusal (`:422`), which says "is closed".
const BARRIER_CLOSED: &str = "OpenCode session is closed";
/// `OpenCode recovery send limit` (`:424`).
const RECOVERY_SEND_LIMIT: &str = "OpenCode recovery send limit";
/// `OpenCode interaction limit` (`:388`).
const INTERACTION_LIMIT: &str = "OpenCode interaction limit";
/// `OpenCode startup event limit` (`:370`).
const STARTUP_LIMIT: &str = "OpenCode startup event limit";

/// The six event types `catalog.changed` refreshes (`extension-catalog.ts:99`-`:105`).
const CATALOG_TYPES: [&str; 6] = [
    "config.updated",
    "plugin.updated",
    "mcp.status.changed",
    "command.updated",
    "skill.updated",
    "agent.updated",
];

/// The port names, each the TypeScript method it replaces.
const PORT_ADMIT: &str = "admitEnvironment";
const PORT_RECONCILE: &str = "reconcile";
const PORT_CATALOG: &str = "catalog.changed";
const PORT_MCP_FORGET: &str = "mcp.forget";

/// What the facade gives a tenant when it opens (`ctx` and the server's view).
pub struct TenantConfig {
    pub cwd: String,
    pub root_key: String,
    /// `ctx.resume?.nativeSessionId ?? ""`: the root a resume expects.
    pub resume: String,
    /// `ctx.aceMcp?.bearer`: replaced in a frame's text, never in the wire.
    pub bearer: Option<String>,
    /// The server's secrets at construction; `set_secrets` follows `addSecret`.
    pub secrets: Vec<String>,
}

/// One pending interaction, as `receive` recorded it (`:381`-`:395`).
#[derive(Debug, Clone)]
pub struct PendingInteraction {
    pub session: String,
    pub data: Value,
    pub kind: String,
}

#[derive(Default)]
struct OpeningBuffer {
    events: Vec<Value>,
    bytes: usize,
}

/// One port on the tenant's queue: the facade runs it and answers through the
/// handle. `json` is the call's argument object, as `JSON.stringify` writes it.
pub(crate) fn port(queue: &EventQueue, name: &'static str, json: Value) {
    queue.publish(vec![SessionEvent::Port {
        name,
        json: ace_json::to_string(&json),
    }]);
}

/// One session's tenant state.
pub struct OpenCodeTenant {
    queue: EventQueue,
    cwd: String,
    bearer: Option<String>,
    secrets: Mutex<Vec<String>>,
    ownership: Mutex<SessionOwnership>,
    translator: Mutex<Translator>,
    evidence: Mutex<RecoveryEvidence>,
    ancestry: Mutex<AncestryProbe>,
    /// The translator's facts, cleared per frame and never parsed.
    facts: Mutex<String>,
    opening: AtomicBool,
    closed: AtomicBool,
    recovering: AtomicBool,
    recovery_started: AtomicU64,
    opening_buffer: Mutex<OpeningBuffer>,
    /// `session.moved` ids with a refetch in flight (`:348`).
    moves: Mutex<IndexSet<String>>,
    pending: Mutex<IndexMap<String, PendingInteraction>>,
    execution_observed: Mutex<IndexSet<String>>,
    /// Barrier promise ids waiting for the pass (`:424`).
    waiters: Mutex<Vec<u64>>,
    /// A recovery the tenant asked for mid-event; the server takes it after
    /// the accept or receive that set it, so `beginRecovery` runs in the loop.
    reconcile: AtomicBool,
    /// The `http` request space (E3-opencode.3).
    http: Mutex<Http>,
    /// The ancestry chains in flight, one per probed session.
    lookups: Mutex<IndexMap<String, Lookup>>,
    /// `this.history`: the heads the pass's refresh stops at (`session.ts:73`).
    history: Mutex<HistoryReader>,
    /// `this.recoveryRead` and `prepareReplay`'s loop (`:509`, `:550`).
    recovery: Mutex<recovery::RecoveryRun>,
    /// `server.eventWatermark` at the reply the facade is delivering.
    watermark: AtomicU64,
}

impl OpenCodeTenant {
    pub fn new(queue: EventQueue, config: TenantConfig) -> Self {
        let admitted_queue = queue.clone();
        let ownership = SessionOwnership::new(
            &config.cwd,
            &config.resume,
            Some(Box::new(move |id| {
                port(&admitted_queue, PORT_ADMIT, json!({ "sessionID": id }));
            })),
        );
        Self {
            queue,
            cwd: config.cwd,
            bearer: config.bearer,
            secrets: Mutex::new(config.secrets),
            ownership: Mutex::new(ownership),
            translator: Mutex::new(Translator::new(config.root_key)),
            evidence: Mutex::new(RecoveryEvidence::new()),
            ancestry: Mutex::new(AncestryProbe::new()),
            facts: Mutex::new(String::new()),
            opening: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            recovering: AtomicBool::new(false),
            recovery_started: AtomicU64::new(0),
            opening_buffer: Mutex::new(OpeningBuffer::default()),
            moves: Mutex::new(IndexSet::new()),
            pending: Mutex::new(IndexMap::new()),
            execution_observed: Mutex::new(IndexSet::new()),
            waiters: Mutex::new(Vec::new()),
            reconcile: AtomicBool::new(false),
            http: Mutex::new(Http::new()),
            lookups: Mutex::new(IndexMap::new()),
            history: Mutex::new(HistoryReader::new()),
            recovery: Mutex::new(recovery::RecoveryRun::default()),
            watermark: AtomicU64::new(0),
        }
    }

    pub fn root(&self) -> String {
        self.lock_ownership().root().to_owned()
    }

    /// `directory`: the root's stored directory, or the context's.
    pub fn directory(&self) -> String {
        let ownership = self.lock_ownership();
        ownership
            .sessions()
            .get(ownership.root())
            .map_or_else(|| self.cwd.clone(), |owner| owner.directory.clone())
    }

    pub fn has_session(&self, id: &str) -> bool {
        self.lock_ownership().sessions().contains_key(id)
    }

    pub fn descendants(&self, root: &str) -> Result<Vec<String>, TenantError> {
        self.lock_ownership()
            .descendants(root)
            .map_err(|error| TenantError(error.to_string()))
    }

    /// Every shell and the session that owns it.
    pub fn shells(&self) -> IndexMap<String, String> {
        self.lock_ownership().shells().clone()
    }

    /// One pending interaction, for an answer or an interrupt.
    pub fn pending(&self, key: &str) -> Option<PendingInteraction> {
        self.lock_pending().get(key).cloned()
    }

    /// `translator.liveShell`: whether a shell still holds work open.
    pub fn live_shell(&self, id: &str) -> bool {
        self.lock_translator().live_shell(id)
    }

    /// `translator.taskOwner`: which session a background task belongs to.
    pub fn task_owner(&self, task: &str) -> Option<String> {
        self.lock_translator().task_owner(task)
    }

    /// `translator.isSettled`.
    pub fn is_settled(&self) -> bool {
        self.lock_translator().is_settled()
    }

    /// `translator.liveMessages`, oldest first, as the handle's JSON.
    pub fn live_messages_json(&self, session: &str) -> String {
        let mut out = String::new();
        self.lock_translator().live_messages_json(session, &mut out);
        out
    }

    /// `server.redact` after an `addSecret`: the facade fans a new secret out.
    pub fn set_secrets(&self, secrets: Vec<String>) {
        *self.lock_secrets() = secrets;
    }

    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn recovering(&self) -> bool {
        self.recovering.load(Ordering::SeqCst)
    }

    /// `this.opening`: the opening buffer still holds the pass off.
    pub(crate) fn opening(&self) -> bool {
        self.opening.load(Ordering::SeqCst)
    }

    // Lock helpers: the tenant is shared across the server's inputs, so every
    // map is behind its own mutex. Poisoning would mean a panic elsewhere; the
    // data is still the last consistent state, so recover it.
    pub(crate) fn lock_secrets(&self) -> MutexGuard<'_, Vec<String>> {
        self.secrets
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_ownership(&self) -> MutexGuard<'_, SessionOwnership> {
        self.ownership
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_translator(&self) -> MutexGuard<'_, Translator> {
        self.translator
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_evidence(&self) -> MutexGuard<'_, RecoveryEvidence> {
        self.evidence
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn lock_ancestry(&self) -> MutexGuard<'_, AncestryProbe> {
        self.ancestry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_http(&self) -> MutexGuard<'_, Http> {
        self.http.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_lookups(&self) -> MutexGuard<'_, IndexMap<String, Lookup>> {
        self.lookups
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_history(&self) -> MutexGuard<'_, HistoryReader> {
        self.history
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn lock_recovery(&self) -> MutexGuard<'_, recovery::RecoveryRun> {
        self.recovery
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn lock_facts(&self) -> MutexGuard<'_, String> {
        self.facts.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn lock_opening(&self) -> MutexGuard<'_, OpeningBuffer> {
        self.opening_buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn lock_moves(&self) -> MutexGuard<'_, IndexSet<String>> {
        self.moves.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn lock_pending(&self) -> MutexGuard<'_, IndexMap<String, PendingInteraction>> {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn lock_execution(&self) -> MutexGuard<'_, IndexSet<String>> {
        self.execution_observed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn lock_waiters(&self) -> MutexGuard<'_, Vec<u64>> {
        self.waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn bearer(&self) -> Option<&str> {
        self.bearer.as_deref()
    }
}

#[cfg(test)]
mod tests;

mod input;
