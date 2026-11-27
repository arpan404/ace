// SPDX-License-Identifier: Apache-2.0
//! The catalog actor: one thread owns every piece of mutable catalog state and every
//! decision about it. Work it cannot do inline (discovery, probes, deletions) runs in
//! spawned tasks that report back with the token they were given.

use std::collections::{BTreeMap, BTreeSet};
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;

use ace_models::instance::ModelInstance;
use ace_protocol::generated::ProviderKind;

use crate::catalog::commands::{Command, Envelope, FlightOutcome, Reply, Reporter};
use crate::catalog::flights::Commit;
use crate::catalog::mailbox::{Ingress, Inputs};
use crate::catalog::notify::NotifyLane;
use crate::catalog::storage_lane::{Cancel, Outcome, StorageLane};
use crate::catalog::timers::{Timer, Timers};
use crate::catalog::turns;
use crate::catalog::{
    CatalogError, CatalogOptions, DiscoveryDiagnostics, DiscoveryFailure, ErrorReport, Inner,
    InstanceStatus, ModelFilter, PendingOp, State, empty_status, status_of,
};
use crate::failures::{FailureCode, discovery_error};
use crate::gate::RefreshCause;
use crate::signals::{Limiter, Signal};

/// What kind of work a spawned task is, so a task that panics or is dropped can be
/// settled the way that kind requires.
#[derive(Clone)]
pub(crate) enum TaskKind {
    Flight { id: String, token: u64 },
    Probe { id: String, token: u64 },
    Removal { id: String, token: u64 },
    Invalidation { id: String, token: u64 },
    Permission { id: String, place: u64 },
    Reconcile,
}

/// One explicit refresh waiting for its flights.
pub(crate) struct RefreshBatch {
    pub(crate) ids: Vec<String>,
    /// The flight token each row's answer is owed by: an older flight settling for the
    /// same id must never be mistaken for the replacement this batch waits on.
    pub(crate) pending: BTreeMap<String, u64>,
    pub(crate) reply: Reply<Result<Vec<InstanceStatus>, CatalogError>>,
}

/// One invalidation pass waiting for its deletions.
pub(crate) struct InvalidationBatch {
    pub(crate) remaining: usize,
    pub(crate) error: Option<crate::cache::CacheError>,
    pub(crate) reply: Reply<Result<(), CatalogError>>,
}

/// Reports its task's end on every path, including a panic, a drop before the first poll,
/// or a normal return. Close waits for these. The report never blocks: it goes to the
/// unbounded completion queue, not the callers' bounded mailbox.
struct TaskGuard {
    task: u64,
    reporter: Reporter,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.reporter
            .report(Command::TaskSettled { task: self.task });
    }
}

/// State the catalog handle shares with the actor so a closed catalog can still answer
/// what it held and what its final close returned.
pub(crate) struct Shared {
    pub(crate) close_result: Arc<Mutex<Option<Result<(), CatalogError>>>>,
    pub(crate) instance_ids: Arc<Mutex<BTreeSet<String>>>,
}
mod durable;
mod shutdown;
mod task_control;
use durable::CloseStage;
pub(crate) use durable::{DeleteWait, SessionWritePlan, StorageWait};
use task_control::TaskControl;

pub(crate) struct Actor {
    pub(crate) inner: Inner,
    pub(crate) options: Arc<CatalogOptions>,
    pub(crate) inputs: Inputs,
    pub(crate) lane: StorageLane,
    pub(crate) limiter: Limiter,
    /// A weak name of the callers' mailbox: the actor never keeps itself alive for it.
    pub(crate) commands: Weak<Ingress>,
    pub(crate) reporter: Reporter,
    pub(crate) notify: NotifyLane,
    dispatch: NotifyLane,
    pub(crate) timers: Timers,
    pub(crate) reconciling: bool,
    terminate: bool,
    close_result: Arc<Mutex<Option<Result<(), CatalogError>>>>,
    pub(crate) instance_ids: Arc<Mutex<BTreeSet<String>>>,
    in_flight: BTreeMap<u64, (TaskKind, TaskControl)>,
    next_task: u64,
    next_place: u64,
    pub(crate) flight_waiters: BTreeMap<u64, Vec<Reply<InstanceStatus>>>,
    pub(crate) refresh_ok_waiters: BTreeMap<u64, Vec<Reply<Result<(), CatalogError>>>>,
    pub(crate) refresh_batches: BTreeMap<u64, RefreshBatch>,
    pub(crate) next_batch: u64,
    pub(crate) invalidation_batches: BTreeMap<u64, InvalidationBatch>,
    pub(crate) next_invalidation_batch: u64,
    pub(crate) invalidation_batch_of: BTreeMap<u64, u64>,
    pub(crate) probe_waiters: BTreeMap<u64, Vec<Reply<Result<(), CatalogError>>>>,
    /// Which row a counted probe belongs to, so its token can free it after the row moved.
    pub(crate) probe_rows: BTreeMap<u64, String>,
    pub(crate) probe_signals: BTreeMap<u64, Signal>,
    storage_waits: BTreeMap<u64, StorageWait>,
    deletion_jobs: BTreeMap<String, durable::Deletion>,
    replace_owners: BTreeMap<String, durable::ReplaceOwner>,
    next_storage: u64,
    pending_storage: usize,
    flight_permits: BTreeMap<u64, Cancel>,
    close_stage: CloseStage,
    pub(crate) probe_cancels: BTreeMap<u64, Timer>,
    flight_cancels: BTreeMap<u64, Timer>,
    flight_deadlines: BTreeMap<u64, f64>,
    pub(crate) flight_tasks: usize,
    flight_io: BTreeSet<u64>,
    pub(crate) removal_tasks: usize,
    pub(crate) timed_out_probes: BTreeSet<u64>,
    pub(crate) next_probe: u64,
    next_listener: u64,
    pub(crate) next_removal: u64,
    pub(crate) next_invalidation: u64,
    pub(crate) refresh_after: BTreeSet<String>,
    close_waiters: Vec<Reply<Result<(), CatalogError>>>,
    closing: bool,
    quiesce_waiters: Vec<Reply<()>>,
    pub(crate) pending_commits: usize,
    commit_tokens: BTreeSet<u64>,
}

impl Actor {
    pub(crate) fn new(
        mut inner: Inner,
        stored: Vec<crate::cache::CacheEntry>,
        options: Arc<CatalogOptions>,
        limiter: Limiter,
        reporter: Reporter,
        lane: StorageLane,
        shared: Shared,
    ) -> Result<Self, CatalogError> {
        let notify = NotifyLane::notifications().map_err(|_| CatalogError::Closed)?;
        let dispatch =
            NotifyLane::new("ace-model-catalog-spawner", 512).map_err(|_| CatalogError::Closed)?;
        let timers = Timers::new(options.deadline.clone(), reporter.clone())
            .map_err(|_| CatalogError::Closed)?;
        for entry in stored {
            if entry.provider == ProviderKind::Acp {
                inner.acp_loaded.insert(entry.instance.clone());
            }
            let owned: Vec<ace_protocol::generated::CatalogModel> =
                entry.models.iter().map(|row| (**row).clone()).collect();
            let models = crate::cleanup::clean_catalog(&owned);
            let retained = crate::sources::refreshed_sources(
                models.into_iter().map(Arc::new).collect(),
                entry.sources.as_deref(),
                None,
                entry.refreshed_at,
            );
            let mut entry = entry;
            entry.models = retained.models;
            entry.sources = Some(retained.sources);
            inner.persisted_order.push(entry.instance.clone());
            inner.persisted.insert(entry.instance.clone(), entry);
        }
        Ok(Self {
            inner,
            options,
            inputs: Inputs::default(),
            lane,
            limiter,
            commands: reporter.commands.clone(),
            reporter,
            notify,
            dispatch,
            timers,
            reconciling: false,
            terminate: false,
            close_result: shared.close_result,
            instance_ids: shared.instance_ids,
            in_flight: BTreeMap::new(),
            next_task: 0,
            next_place: 0,
            flight_waiters: BTreeMap::new(),
            refresh_ok_waiters: BTreeMap::new(),
            refresh_batches: BTreeMap::new(),
            next_batch: 0,
            invalidation_batches: BTreeMap::new(),
            next_invalidation_batch: 0,
            invalidation_batch_of: BTreeMap::new(),
            probe_waiters: BTreeMap::new(),
            probe_rows: BTreeMap::new(),
            probe_signals: BTreeMap::new(),
            storage_waits: BTreeMap::new(),
            deletion_jobs: BTreeMap::new(),
            replace_owners: BTreeMap::new(),
            next_storage: 0,
            pending_storage: 0,
            flight_permits: BTreeMap::new(),
            close_stage: CloseStage::Idle,
            probe_cancels: BTreeMap::new(),
            flight_cancels: BTreeMap::new(),
            flight_deadlines: BTreeMap::new(),
            flight_tasks: 0,
            flight_io: BTreeSet::new(),
            removal_tasks: 0,
            timed_out_probes: BTreeSet::new(),
            next_probe: 0,
            next_listener: 0,
            next_removal: 0,
            next_invalidation: 0,
            refresh_after: BTreeSet::new(),
            close_waiters: Vec::new(),
            closing: false,
            quiesce_waiters: Vec::new(),
            pending_commits: 0,
            commit_tokens: BTreeSet::new(),
        })
    }

    /// Runs until the callers' mailbox closes or a successful close asks the thread to
    /// end. Work the actor owns reports on its own queue, checked before every wait, so a
    /// completion never waits behind a full callers' mailbox.
    pub(crate) fn run(
        mut self,
        receiver: std::sync::mpsc::Receiver<Envelope>,
        completions: std::sync::mpsc::Receiver<Envelope>,
    ) {
        loop {
            while let Ok(envelope) = completions.try_recv() {
                self.handle_envelope(envelope);
            }
            if self.terminate {
                drop(receiver);
                self.lane.shutdown();
                return;
            }
            match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(envelope) => self.handle_envelope(envelope),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    // Every handle is gone: finish what was already reported and leave.
                    while let Ok(envelope) = completions.try_recv() {
                        self.handle_envelope(envelope);
                    }
                    drop(receiver);
                    self.lane.shutdown();
                    return;
                }
            }
            if self.terminate {
                drop(receiver);
                self.lane.shutdown();
                return;
            }
        }
    }

    fn handle_envelope(&mut self, envelope: Envelope) {
        if self.inner.closed && envelope.ack.is_some() && !envelope.command.allowed_during_close() {
            return;
        }
        if let Some(mut inputs) = envelope.inputs
            && inputs.sequence > self.inputs.sequence
        {
            inputs.now = inputs.now.max(self.inputs.now);
            self.inputs = inputs;
        }
        if let Some(now) = envelope.observed_at {
            self.inputs.now = self.inputs.now.max(now);
        }
        self.handle_command(envelope.command);
        self.lane.pump();
        if let Some(ack) = envelope.ack {
            let _ = ack.send(());
        }
    }

    fn handle_command(&mut self, command: Command) {
        match command {
            Command::Wake => {}
            Command::List {
                filter,
                offset,
                limit,
                reply,
            } => self.list(filter, offset, limit, reply),
            Command::Resolve {
                spec,
                cached,
                reply,
            } => self.resolve(spec, cached, reply),
            Command::HasProvider { provider, reply } => {
                let value = self
                    .inner
                    .providers
                    .get(&provider)
                    .is_some_and(|ids| !ids.is_empty());
                let _ = reply.send(value);
            }
            Command::HasInstance { id, reply } => {
                let _ = reply.send(self.inner.states.contains_key(&id));
            }
            Command::HasFlight { id, reply } => {
                let value = self
                    .inner
                    .states
                    .get(&id)
                    .is_some_and(|state| state.flight.is_some());
                let _ = reply.send(value);
            }
            Command::Registered { id, reply } => {
                let value = self.inner.states.get(&id).map(|state| state.config.clone());
                let _ = reply.send(value);
            }
            Command::Registration { id, reply } => {
                let value = self.inner.states.get(&id).map(|state| {
                    (
                        state.config.clone(),
                        crate::catalog::RegistrationToken(state.generation),
                    )
                });
                let _ = reply.send(value);
            }
            Command::Listen { listener, reply } => {
                if self.inner.closed {
                    let _ = reply.send(Err(CatalogError::Closed));
                } else if self.inner.listeners.len() >= 4096 {
                    let _ = reply.send(Err(CatalogError::ListenerLimit));
                } else {
                    self.next_listener += 1;
                    let token = self.next_listener;
                    self.inner.listeners.insert(token, listener);
                    let _ = reply.send(Ok(token));
                }
            }
            Command::Unlisten { token } => {
                self.inner.listeners.remove(&token);
            }
            Command::MarkStale { filter, reply } => {
                let result = self.mark_stale(&filter);
                let _ = reply.send(result);
            }
            Command::Register {
                input,
                admit,
                reply,
            } => {
                let result = self.register(input, admit);
                let _ = reply.send(result);
            }
            Command::ConfigurationChanged { reply } => {
                self.configuration_changed();
                let _ = reply.send(());
            }
            Command::InstallationChanged {
                provider,
                version,
                runtime,
                reply,
            } => {
                self.installation_changed(provider, &version, &runtime);
                let _ = reply.send(());
            }
            Command::LoginChanged {
                instance,
                revision,
                sign_in_method,
                reply,
            } => {
                let result = self.login_changed(&instance, &revision, sign_in_method);
                let _ = reply.send(result);
            }
            Command::Remove { instance, reply } => self.remove(instance, reply),
            Command::Invalidate { filter, reply } => self.invalidate(filter, reply),
            Command::Refresh {
                filter,
                mode,
                reply,
            } => self.refresh(filter, mode, reply),
            Command::RefreshState { id, cause, reply } => self.refresh_state(&id, cause, reply),
            Command::UpdateSession {
                input,
                token,
                metadata,
                reply,
            } => self.update_session(input, token, &metadata, reply),
            Command::UpdateModes {
                instance,
                token,
                modes,
                reply,
            } => {
                self.update_modes(&instance, token, modes);
                let _ = reply.send(());
            }
            Command::HoldTurn { id, reply } => {
                if !self.test_turn_allowed() {
                    return;
                }
                let token = self.next_place();
                let entry = self.inner.turns.entry(id.clone()).or_default();
                let granted = entry.hold(token);
                let _ = reply.send((token, granted));
                self.pump(&id);
            }
            Command::ReserveTurn { id, reply } => {
                if !self.test_turn_allowed() {
                    return;
                }
                let token = self.next_place();
                self.inner.turns.entry(id).or_default().reserve(token);
                let _ = reply.send(token);
            }
            Command::SettleTurn { id, token, reply } => {
                if let Some(entry) = self.inner.turns.get_mut(&id) {
                    entry.settle(token);
                }
                let _ = reply.send(());
                self.pump(&id);
            }
            Command::ResetPause { id, reply } => {
                if let Some(state) = self.inner.states.get_mut(&id) {
                    state.probe_retry_at = 0.0;
                    state.backoff.reset();
                    state.retry_at = 0.0;
                }
                let _ = reply.send(());
            }
            Command::Close { reply } => self.close(reply),
            Command::ReconcileIds { reply } => {
                let ids = if self.inner.closed {
                    None
                } else {
                    Some(
                        self.inner
                            .order
                            .iter()
                            .filter(|id| {
                                self.inner.states.get(*id).is_some_and(|state| {
                                    matches!(
                                        state.config.provider,
                                        ProviderKind::Opencode | ProviderKind::Pi
                                    ) && self.enabled(&state.config)
                                })
                            })
                            .cloned()
                            .collect(),
                    )
                };
                let _ = reply.send(ids);
            }
            Command::Probe { id, reply } => self.probe(&id, reply),
            Command::Observe { reply } => {
                if self.inner.closed || self.options.connection_check_ms.is_none() {
                    let _ = reply.send(None);
                } else {
                    self.inner.observers += 1;
                    let _ = reply.send(Some(0));
                }
            }
            Command::UnobserveWith { reply } => {
                self.inner.observers = self.inner.observers.saturating_sub(1);
                let _ = reply.send(());
            }
            Command::PendingWork { reply } => {
                let _ = reply.send(self.inner.session_writes);
            }
            Command::RetainedReplies { reply } => {
                let _ = reply.send(self.retained_replies());
            }
            Command::Quiesce { reply } => {
                self.quiesce_waiters.retain(|waiter| !waiter.is_canceled());
                if self.quiesce_ready()
                    || self.quiesce_waiters.len() >= crate::catalog::WAITER_LIMIT
                {
                    let _ = reply.send(());
                } else {
                    self.quiesce_waiters.push(reply);
                }
            }
            Command::Inspect { id, reply } => {
                let facts = self.inner.states.get(&id).map(|state| {
                    (
                        state.connection_fingerprint.clone(),
                        state.error.is_some() || state.error_detail.is_some(),
                    )
                });
                let _ = reply.send(facts.unwrap_or((None, false)));
            }
            Command::TaskSettled { task } => self.task_settled(task),
            Command::TimerRetired { key } => self.timers.retired(key),
            Command::StorageDone { key, outcome } => self.storage_done(key, outcome),
            Command::RemovalReady { id, token } => self.removal_ready(&id, token),
            Command::Deadline { id, token } => self.deadline(&id, token),
            Command::ProbeDeadline { id, token } => self.probe_deadline(&id, token),
            Command::FlightAdmit { id, token, reply } => {
                let go = self.admit_flight(&id, token);
                let _ = reply.send(go);
            }
            Command::FlightOutcome {
                id,
                token,
                started_at,
                diagnostics,
                outcome,
                ..
            } => self.flight_outcome(&id, token, started_at, diagnostics, outcome),
            Command::ProbeOutcome {
                id,
                token,
                generation,
                revision,
                started_at,
                result,
                ..
            } => self.probe_outcome(&id, token, generation, &revision, started_at, result),
        }
        self.after_event();
    }

    pub(crate) fn now(&self) -> f64 {
        self.inputs.now
    }

    pub(crate) fn configuration(
        &self,
        config: &ModelInstance,
    ) -> crate::preferences::ProviderConfig {
        crate::preferences::provider_configuration(
            &self.inputs.preferences,
            config.provider,
            Some(&config.id),
        )
    }

    pub(crate) fn enabled(&self, config: &ModelInstance) -> bool {
        self.configuration(config).enabled != Some(false)
    }

    pub(crate) fn revision(&self, config: &ModelInstance) -> String {
        let path = self.configuration(config).binary_path;
        crate::catalog::revision_of(config, path.as_deref())
    }

    pub(crate) fn status(&self, id: &str) -> Option<InstanceStatus> {
        self.inner.states.get(id).map(|state| {
            status_of(
                self.now(),
                self.options.ttl_ms,
                &self.inputs.preferences,
                &self.inner,
                state,
            )
        })
    }

    /// Hands every listener its notification on the listener lane. The actor never calls
    /// user code, so a listener that blocks or reads the catalog cannot stall it.
    pub(crate) fn notify(&mut self, config: &ModelInstance) {
        if self.inner.listeners.is_empty() {
            return;
        }
        let filter = ModelFilter {
            provider: Some(config.provider),
            instance: Some(config.id.clone()),
            ..ModelFilter::default()
        };
        for listener in self.inner.listeners.values() {
            let listener = listener.clone();
            let filter = filter.clone();
            self.notify.submit(move || listener(filter));
        }
    }

    pub(crate) fn notify_id(&mut self, id: &str) {
        if let Some(config) = self.inner.states.get(id).map(|state| state.config.clone()) {
            self.notify(&config);
        }
    }

    /// Spawns one task the actor owns. Its end is reported however it leaves, including a
    /// panic, so close can always finish. A spawner that itself panics is contained here
    /// and the task it was given still settles its token.
    pub(crate) fn spawn(&mut self, kind: TaskKind, future: BoxFuture<'static, ()>) {
        let task = self.next_task;
        self.next_task += 1;
        let control = TaskControl::default();
        self.in_flight.insert(task, (kind, control.clone()));
        let start = control.clone();
        // The guard is a captured value, so dropping the task before its first poll still
        // reports it: close never waits on work the spawner threw away.
        let guard = TaskGuard {
            task,
            reporter: self.reporter.clone(),
        };
        let guarded = Box::pin(async move {
            let _guard = guard;
            if start.start() {
                let _ = AssertUnwindSafe(future).catch_unwind().await;
            }
        });
        let spawn = self.options.spawn.clone();
        self.dispatch.submit(move || {
            if !control.cancelled() {
                spawn.spawn(guarded);
                control.submitted();
            }
        });
    }

    fn task_settled(&mut self, task: u64) {
        let Some((kind, _)) = self.in_flight.remove(&task) else {
            return;
        };
        match kind {
            TaskKind::Flight { id, token } => {
                self.flight_tasks -= 1;
                self.flight_io.remove(&token);
                // A discovery that already reported is waiting for its turn; its task
                // ending is not the flight ending.
                if !self.commit_tokens.contains(&token) {
                    self.abort_flight(&id, token);
                }
            }
            TaskKind::Probe { id, token } => {
                self.inner.probes -= 1;
                self.abort_probe(&id, token);
            }
            TaskKind::Removal { id, token } => {
                self.removal_tasks -= 1;
                // A removal that reached the storage lane settles from its reply; the
                // task ending right after reporting that is not a failure.
                let awaiting = self
                    .inner
                    .removals
                    .get(&id)
                    .is_some_and(|removal| removal.token == token && removal.started);
                if !awaiting {
                    self.removal_done(
                        &id,
                        token,
                        Outcome::Failed(crate::cache::CacheError::Malformed),
                    );
                }
            }
            TaskKind::Invalidation { id, token } => {
                // A deletion's waiter left without reporting; its place still runs the
                // delete when its turn comes, so nothing behind it is stranded.
                self.mark_invalidation_ready(&id, token);
            }
            TaskKind::Permission { id, place } => {
                if let Some(turns) = self.inner.turns.get_mut(&id) {
                    turns.mark_ready(place);
                }
                self.pump(&id);
            }
            TaskKind::Reconcile => self.reconciling = false,
        }
        self.release_quiesce_waiters();
    }

    fn retained_replies(&self) -> usize {
        self.flight_waiters.values().map(Vec::len).sum::<usize>()
            + self
                .refresh_ok_waiters
                .values()
                .map(Vec::len)
                .sum::<usize>()
            + self.probe_waiters.values().map(Vec::len).sum::<usize>()
            + self
                .inner
                .removals
                .values()
                .map(|removal| removal.waiters.len())
                .sum::<usize>()
            + self.close_waiters.len()
            + self.quiesce_waiters.len()
            + self.refresh_batches.len()
    }

    /// Whether no spawned task and no storage job is outstanding.
    fn quiesce_ready(&self) -> bool {
        self.in_flight.is_empty() && self.pending_storage == 0
    }

    fn release_quiesce_waiters(&mut self) {
        if !self.quiesce_ready() {
            return;
        }
        let waiters = std::mem::take(&mut self.quiesce_waiters);
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }

    fn after_event(&mut self) {
        self.finish_close_if_ready();
    }

    pub(crate) fn next_place(&mut self) -> u64 {
        self.next_place += 1;
        self.next_place
    }

    fn test_turn_allowed(&self) -> bool {
        self.inner
            .turns
            .values()
            .map(turns::Turns::len)
            .sum::<usize>()
            < 2048
    }

    pub(crate) fn pump(&mut self, id: &str) {
        loop {
            let step = match self.inner.turns.get_mut(id) {
                Some(turns) => turns.step(),
                None => return,
            };
            match step {
                turns::Step::Run(place, op) => {
                    // A place whose work went to the storage lane settles from the lane's
                    // reply, never here: the next place must not overtake the write.
                    if self.execute_op(id, place, op) {
                        self.settle_place(id, place);
                    }
                }
                turns::Step::Grant(grant) => {
                    let _ = grant.send(());
                }
                turns::Step::Idle => break,
                turns::Step::Empty => break,
            }
        }
        let empty = self.inner.turns.get(id).is_none_or(turns::Turns::is_empty);
        if empty {
            self.inner.turns.remove(id);
        }
        self.finish_close_if_ready();
    }

    /// Runs one place's work; `true` means it settled without storage.
    fn execute_op(&mut self, id: &str, place: u64, op: PendingOp) -> bool {
        match op {
            PendingOp::SessionWrite(write) => self.begin_session_write(*write, place),
            PendingOp::PermissionWrite(write) => self.begin_permission_write(*write, place),
            PendingOp::FlightCommit(commit) => self.begin_commit(commit, place),
            PendingOp::Invalidation { token } => self.begin_invalidation(id, token, place),
        }
    }

    fn flight_expired(&self, token: u64) -> bool {
        self.flight_permits.get(&token).is_some_and(Cancel::expired)
            || self
                .flight_deadlines
                .get(&token)
                .is_some_and(|deadline| self.now() >= *deadline)
    }

    fn deadline(&mut self, id: &str, token: u64) {
        let Some(state) = self
            .inner
            .states
            .get(id)
            .filter(|state| state.flight_token == Some(token))
        else {
            if self.commit_tokens.contains(&token) {
                self.cancel_commit(id, token);
            }
            return;
        };
        let revision = state.probe_revision.clone();
        let started_at = self
            .flight_deadlines
            .get(&token)
            .copied()
            .unwrap_or(self.now())
            - self.options.timeout_ms;
        if revision
            .as_ref()
            .is_some_and(|revision| self.revision(&state.config) == *revision)
        {
            self.fail(
                id,
                None,
                FailureCode::Timeout,
                &FailureReport {
                    started_at,
                    diagnostics: &DiscoveryDiagnostics::default(),
                    revision: revision.as_deref(),
                    token: Some(token),
                },
            );
        }
        self.cancel_commit(id, token);
    }

    pub(crate) fn cancel_obsolete_commits(&mut self, id: &str) {
        let current = self.inner.states.get(id).and_then(|state| {
            state.abort.as_ref().filter(|signal| !signal.is_aborted())?;
            state.flight_token
        });
        let obsolete: Vec<_> = self
            .inner
            .row_flights
            .get(id)
            .into_iter()
            .flatten()
            .filter(|flight| {
                Some(flight.token) != current && self.commit_tokens.contains(&flight.token)
            })
            .map(|flight| flight.token)
            .collect();
        for token in obsolete {
            self.cancel_commit(id, token);
        }
    }

    pub(crate) fn cancel_commit(&mut self, id: &str, token: u64) {
        if self
            .inner
            .turns
            .get_mut(id)
            .is_some_and(|turns| turns.discard_commit(token))
        {
            self.pending_commits -= 1;
        }
        self.commit_tokens.remove(&token);
        self.settle_flight(id, token);
        self.pump(id);
    }

    pub(crate) fn fail(
        &mut self,
        id: &str,
        failure: Option<DiscoveryFailure>,
        fallback: FailureCode,
        report: &FailureReport<'_>,
    ) {
        let Some((config, sources)) = self.inner.states.get(id).map(|state| {
            let sources = state
                .entry
                .as_ref()
                .and_then(|entry| entry.sources.as_ref())
                .map(|sources| sources.iter().map(|status| status.source.clone()).collect());
            (state.config.clone(), sources)
        }) else {
            return;
        };
        let sources: Option<Vec<ace_protocol::generated::ModelSource>> =
            if config.provider == ProviderKind::Opencode {
                None
            } else {
                sources.or_else(|| report.diagnostics.sources.clone())
            };
        let placeholder = DiscoveryFailure::default();
        let named = failure
            .as_ref()
            .or(if report.diagnostics.source_failures.is_empty() {
                None
            } else {
                Some(&placeholder)
            });
        let detail = discovery_error(
            named,
            fallback,
            &crate::failures::ErrorContext {
                provider: Some(&config.provider.to_string()),
                source: sources
                    .as_ref()
                    .filter(|sources| sources.len() == 1)
                    .and_then(|sources| sources.first())
                    .map(|source| source.id.0.as_str()),
                backend: config.backend.map(|_| "cursor-sdk"),
            },
        );
        let now = self.now();
        let unconfigured = matches!(
            detail.code,
            FailureCode::NotConfigured | FailureCode::NotInstalled
        );
        let terminal = matches!(
            detail.code,
            FailureCode::NoModels
                | FailureCode::ParseFailure
                | FailureCode::CliTooOld
                | FailureCode::CliUnsupported
        );
        let schedule = terminal.then(|| {
            (
                if detail.code == FailureCode::NoModels {
                    "info"
                } else {
                    "warn"
                },
                self.options.ttl_ms,
            )
        });
        let mut report_sources: Vec<Option<ace_protocol::generated::ModelSource>> = sources
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(Some)
            .collect();
        if report_sources.is_empty() {
            report_sources.push(None);
        }
        let mut logs: Vec<ReportLog> = Vec::new();
        let mutated = {
            let Some(state) = self.inner.states.get_mut(id) else {
                return;
            };
            if let Some(revision) = report.revision
                && state.probe_revision.as_deref() != Some(revision)
            {
                return;
            }
            if let Some(token) = report.token
                && state.flight_token != Some(token)
            {
                return;
            }
            state.error_detail = Some(detail.clone());
            if unconfigured {
                let first = state.unconfigured_at.is_none();
                state.unconfigured_at = Some(now);
                state.dirty = false;
                state.error = None;
                state.entry = None;
                state.view = None;
                state.backoff.reset();
                state.retry_at = 0.0;
                if state.config.provider == ProviderKind::Acp {
                    self.inner.acp_loaded.insert(id.to_owned());
                }
                if first {
                    logs.push((None, None, None));
                }
                true
            } else {
                state.unconfigured_at = None;
                if let Some((_, retry_in)) = schedule {
                    state.backoff.reset();
                    state.retry_at = now + retry_in;
                } else {
                    let keys: Vec<String> = report_sources
                        .iter()
                        .flatten()
                        .map(|source| source.id.0.clone())
                        .collect();
                    state.backoff.retain(keys);
                }
                for source in &report_sources {
                    let schedule_now = schedule.or_else(|| {
                        state
                            .backoff
                            .fail(
                                source
                                    .as_ref()
                                    .map(|source| source.id.0.as_str())
                                    .unwrap_or(""),
                                detail.code,
                                now,
                                self.options.retry_ms,
                                self.inputs.random,
                            )
                            .ok()
                            .map(|schedule| {
                                (
                                    if schedule.warn { "warn" } else { "debug" },
                                    schedule.retry_in_ms,
                                )
                            })
                    });
                    logs.push((
                        source.as_ref().map(|source| source.id.0.clone()),
                        source.as_ref().map(|source| source.label.0.clone()),
                        schedule_now,
                    ));
                }
                if schedule.is_none() {
                    state.retry_at = state.backoff.retry_at();
                }
                state.error = Some(match fallback {
                    FailureCode::Timeout => crate::catalog::StatusError::Timeout,
                    FailureCode::PersistenceFailed => {
                        crate::catalog::StatusError::PersistenceFailed
                    }
                    _ => crate::catalog::StatusError::DiscoveryFailed,
                });
                true
            }
        };
        if !mutated {
            return;
        }
        for (source, label, schedule) in logs {
            report_line(
                &self.notify,
                &self.options,
                &config,
                &detail,
                source,
                label,
                now - report.started_at,
                schedule,
                report.diagnostics,
            );
        }
        self.notify_id(id);
    }

    pub(crate) fn settle_flight(&mut self, id: &str, token: u64) {
        // Settlement is idempotent: a token that is already released settles nothing.
        if !self.flight_tracked(id, token) {
            return;
        }
        // A write still queued on the lane must not land for a flight that is over.
        if let Some(cancel) = self.flight_permits.remove(&token) {
            cancel.cancel();
        }
        // The gate belongs to the flight, not to whichever row replaced it: an
        // invalidate or remove waiting on it must never hang.
        let gate = self.inner.row_flights.get(id).and_then(|flights| {
            flights
                .iter()
                .find(|flight| flight.token == token)
                .map(|flight| flight.done.clone())
        });
        if let Some(state) = self.inner.states.get_mut(id)
            && state
                .flight
                .as_ref()
                .is_some_and(|flight| flight.token == token)
        {
            state.flight = None;
            if let Some(abort) = state.abort.take() {
                abort.abort();
            }
            state.flight_token = None;
            state.probe_revision = None;
        }
        self.inner.row_flights.retain(|_, flights| {
            flights.retain(|flight| flight.token != token);
            !flights.is_empty()
        });
        if gate.is_some() {
            self.inner.active_flights = self.inner.active_flights.saturating_sub(1);
        }
        if let Some(timer) = self.flight_cancels.remove(&token) {
            self.timers.cancel(timer);
        }
        self.flight_deadlines.remove(&token);
        if let Some(gate) = &gate {
            gate.open();
        }
        let status = self.status(id).unwrap_or_else(|| empty_status(id));
        for waiter in self.flight_waiters.remove(&token).unwrap_or_default() {
            let _ = waiter.send(status.clone());
        }
        for waiter in self.refresh_ok_waiters.remove(&token).unwrap_or_default() {
            let _ = waiter.send(Ok(()));
        }
        self.complete_refresh(id, token, status);
        self.notify_id(id);
        if self.refresh_after.remove(id) && !self.inner.closed && self.inner.states.contains_key(id)
        {
            self.start_flight(id, RefreshCause::Background);
        }
    }

    fn abort_flight(&mut self, id: &str, token: u64) {
        self.settle_flight(id, token);
    }

    /// Whether a flight token still owns anything the actor can settle.
    fn flight_tracked(&self, id: &str, token: u64) -> bool {
        self.inner
            .row_flights
            .get(id)
            .is_some_and(|flights| flights.iter().any(|flight| flight.token == token))
            || self
                .inner
                .states
                .get(id)
                .is_some_and(|state| state.flight_token == Some(token))
            || self.flight_cancels.contains_key(&token)
            || self.flight_permits.contains_key(&token)
            || self.flight_waiters.contains_key(&token)
            || self.refresh_ok_waiters.contains_key(&token)
            || self.commit_tokens.contains(&token)
    }

    /// Whether a flight token still owns a running row flight.
    pub(crate) fn flight_alive(&self, id: &str, token: u64) -> bool {
        self.inner
            .row_flights
            .get(id)
            .is_some_and(|flights| flights.iter().any(|flight| flight.token == token))
    }

    fn complete_refresh(&mut self, id: &str, token: u64, status: InstanceStatus) {
        // A row that already started its replacement flight keeps the batch waiting for
        // that flight, never for the one that just settled.
        let live = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.flight.as_ref().map(|flight| flight.token));
        let mut completed = Vec::new();
        for (batch_token, batch) in &mut self.refresh_batches {
            if batch.pending.get(id) != Some(&token) {
                continue;
            }
            match live {
                Some(next) if next != token => {
                    batch.pending.insert(id.to_owned(), next);
                }
                _ => {
                    batch.pending.remove(id);
                    if batch.pending.is_empty() {
                        completed.push(*batch_token);
                    }
                }
            }
        }
        for token in completed {
            if let Some(batch) = self.refresh_batches.remove(&token) {
                let statuses = batch
                    .ids
                    .iter()
                    .filter_map(|known| {
                        self.status(known)
                            .or_else(|| (known == id).then(|| status.clone()))
                    })
                    .collect();
                let _ = batch.reply.send(Ok(statuses));
            }
        }
    }

    fn admit_flight(&mut self, id: &str, token: u64) -> bool {
        let facts = self.inner.states.get(id).and_then(|state| {
            state
                .flight
                .as_ref()
                .filter(|flight| flight.token == token)
                .map(|_| (state.generation, state.config.clone()))
        });
        let Some((generation, config)) = facts else {
            self.settle_flight(id, token);
            return false;
        };
        let aborted = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.abort.as_ref())
            .is_some_and(Signal::is_aborted);
        if self.inner.closed || aborted {
            self.settle_flight(id, token);
            return false;
        }
        let revision = self.revision(&config);
        let current = self.inner.states.get(id).is_some_and(|state| {
            state.generation == generation && state.probe_revision.as_deref() == Some(&revision)
        });
        if !current {
            self.settle_flight(id, token);
            return false;
        }
        if let Some(cli) = crate::cli::provider_cli(&config.provider.to_string())
            && let Err(too_old) =
                crate::cli::require_minimum(cli, config.installation_version.as_deref())
        {
            let failure = DiscoveryFailure {
                code: Some(FailureCode::CliTooOld.as_str().to_owned()),
                too_old: Some(too_old),
                ..DiscoveryFailure::default()
            };
            self.fail(
                id,
                Some(failure),
                FailureCode::CliTooOld,
                &FailureReport {
                    started_at: self.now(),
                    diagnostics: &DiscoveryDiagnostics::default(),
                    revision: Some(&revision),
                    token: Some(token),
                },
            );
            self.settle_flight(id, token);
            return false;
        }
        if !self.flight_cancels.contains_key(&token) {
            return false;
        }
        self.flight_io.insert(token);
        true
    }

    pub(crate) fn arm_flight_deadline(&mut self, id: &str, token: u64) {
        if self.flight_cancels.contains_key(&token) {
            return;
        }
        let deadline_at = self.now() + self.options.timeout_ms;
        self.flight_deadlines.insert(token, deadline_at);
        let permit = Cancel::until(self.options.clock.clone(), deadline_at);
        self.flight_permits.insert(token, permit.clone());
        let reporter = self.reporter.clone();
        let deadline_id = id.to_owned();
        let timer = self.timers.arm(
            self.options.timeout_ms,
            Box::new(move || {
                if !permit.expire() {
                    return;
                }
                reporter.report(Command::Deadline {
                    id: deadline_id.clone(),
                    token,
                });
            }),
        );
        if let Some(timer) = timer {
            self.flight_cancels.insert(token, timer);
        } else {
            self.deadline(id, token);
        }
    }

    fn flight_outcome(
        &mut self,
        id: &str,
        token: u64,
        started_at: f64,
        diagnostics: DiscoveryDiagnostics,
        outcome: FlightOutcome,
    ) {
        let Some((generation, revision, aborted)) = self.inner.states.get(id).and_then(|state| {
            state
                .flight
                .as_ref()
                .filter(|flight| flight.token == token)
                .map(|_| {
                    (
                        state.generation,
                        state.probe_revision.clone().unwrap_or_default(),
                        state.abort.as_ref().is_some_and(Signal::is_aborted),
                    )
                })
        }) else {
            return;
        };
        if self.flight_expired(token) {
            self.deadline(id, token);
            return;
        }
        let report = FailureReport {
            started_at,
            diagnostics: &diagnostics,
            revision: Some(&revision),
            token: Some(token),
        };
        if aborted
            || !self.write_current(id, generation, &revision)
            || matches!(&outcome, FlightOutcome::None)
        {
            self.settle_flight(id, token);
            return;
        }
        match outcome {
            FlightOutcome::None => {
                self.settle_flight(id, token);
            }
            FlightOutcome::Admission(error) => {
                let current = self.with_state(id, |state| {
                    state.entry = None;
                    state.view = None;
                    state.dirty = true;
                });
                if current {
                    self.begin_delete(id);
                }
                self.fail(
                    id,
                    Some(DiscoveryFailure::new(&error)),
                    FailureCode::DiscoveryFailed,
                    &report,
                );
                self.settle_flight(id, token);
            }
            FlightOutcome::Failed(failure) => {
                let failure = *failure;
                let code = failure
                    .code
                    .as_deref()
                    .and_then(|code| {
                        crate::failures::DISCOVERY_FAILURE_CODES
                            .iter()
                            .copied()
                            .find(|known| known.as_str() == code)
                    })
                    .unwrap_or(FailureCode::DiscoveryFailed);
                self.fail(id, Some(failure), code, &report);
                self.settle_flight(id, token);
            }
            FlightOutcome::Discovered(outcome) => {
                if outcome.models.is_empty() && outcome.sources.is_none() {
                    self.fail(
                        id,
                        Some(DiscoveryFailure::new("The CLI returned no model choices")),
                        FailureCode::DiscoveryFailed,
                        &report,
                    );
                    self.settle_flight(id, token);
                    return;
                }
                let commit = Commit {
                    id: id.to_owned(),
                    token,
                    generation,
                    revision,
                    started_at,
                    diagnostics,
                    outcome,
                };
                let place = self.next_place();
                self.inner
                    .turns
                    .entry(id.to_owned())
                    .or_default()
                    .accept(place, PendingOp::FlightCommit(Box::new(commit)));
                self.pending_commits += 1;
                self.commit_tokens.insert(token);
                self.pump(id);
            }
        }
    }

    fn with_state(&mut self, id: &str, change: impl FnOnce(&mut State)) -> bool {
        match self.inner.states.get_mut(id) {
            Some(state) => {
                change(state);
                true
            }
            None => false,
        }
    }

    /// Whether a flight may still write: it owns its row and token, was not aborted, and
    /// the row's effective revision is still the one it started under.
    pub(crate) fn flight_current(
        &self,
        id: &str,
        token: u64,
        generation: u64,
        revision: &str,
    ) -> bool {
        let Some(state) = self.inner.states.get(id) else {
            return false;
        };
        if self.inner.closed
            || state.generation != generation
            || state.flight_token != Some(token)
            || state.abort.as_ref().is_some_and(Signal::is_aborted)
            || self
                .flight_permits
                .get(&token)
                .is_some_and(Cancel::cancelled)
        {
            return false;
        }
        self.revision(&state.config) == revision
    }
}

/// One per-source log line: its source, its label and its schedule.
type ReportLog = (Option<String>, Option<String>, Option<(&'static str, f64)>);

/// One flight's local report of a failure.
pub(crate) struct FailureReport<'a> {
    pub(crate) started_at: f64,
    pub(crate) diagnostics: &'a DiscoveryDiagnostics,
    pub(crate) revision: Option<&'a str>,
    pub(crate) token: Option<u64>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn report_line(
    notify: &NotifyLane,
    options: &CatalogOptions,
    config: &ModelInstance,
    detail: &crate::failures::DiscoveryError,
    source: Option<String>,
    source_label: Option<String>,
    duration_ms: f64,
    schedule: Option<(&str, f64)>,
    diagnostics: &DiscoveryDiagnostics,
) {
    let Some(on_error) = &options.on_error else {
        return;
    };
    let report = ErrorReport {
        provider: config.provider,
        instance: config.id.clone(),
        error: detail.clone(),
        source,
        source_label,
        duration_ms: duration_ms.max(0.0),
        cli_version: diagnostics.cli_version.clone(),
        stage: diagnostics.stage.clone(),
        level: schedule.map(|(level, _)| level.to_owned()),
        retry_in_ms: schedule.map(|(_, retry_in)| retry_in),
        reason: None,
        model_index: None,
    };
    let on_error = on_error.clone();
    notify.submit(move || on_error(report));
}
