// SPDX-License-Identifier: Apache-2.0
//! The catalog's state machine (`packages/models/src/catalog.ts`) as one actor.
//!
//! One task owns every mutable piece of catalog state: rows, registrations, flights,
//! per-instance order, reservations, invalidations, removals, capacity counters and the
//! closed flag. Callers only send a [`Command`] with a oneshot reply and await it. Slow
//! work (discovery, probes, listing, removal deletion) runs in tasks the actor spawns and
//! reports back with its token and generation; the actor alone decides whether a result
//! commits, in what order per instance, and when a deadline wins. A caller that goes away
//! just drops its reply receiver: the catalog still finishes the work.

mod actor;
mod commands;
mod flights;
mod lifecycle;
mod notify;
mod refresh;
mod registration;
mod storage;
mod storage_lane;
#[cfg(test)]
mod tests;
mod turns;
mod types;
mod writes;

pub(crate) use commands::{Command, Envelope, RefreshMode, Reply};
pub(crate) use lifecycle::CancelHandle;
pub(crate) use turns::Turns;
pub(crate) use writes::{PermissionWrite, SessionWrite};

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use ace_models::instance::{Backend, ModelInstance};
use ace_protocol::generated::{CatalogModel, ProviderKind};
use futures::future::BoxFuture;
use serde_json::Value;

use crate::backoff::DiscoveryBackoff;
use crate::cache::{CacheEntry, SharedStorage};
use crate::failures::{DiscoveryError, DiscoveryFailure, FailureCode};
use crate::gate::{AcpProbeSpacing, RefreshCause};
use crate::preferences::{ProviderConfig, configured_models};
use crate::resolve::{Resolution, RoleSpec};
use crate::sources::{SourceState, SourceStatus};

/// The longest a row is served before it is stale (six hours).
pub const DEFAULT_TTL_MS: f64 = 21_600_000.0;
/// How long one discovery may run before it is aborted.
pub const DEFAULT_TIMEOUT_MS: f64 = 15_000.0;
/// The first retry pause after a failed discovery.
pub const DEFAULT_RETRY_MS: f64 = 30_000.0;
/// The least time between two probes of one ACP agent's row.
pub const DEFAULT_ACP_PROBE_INTERVAL_MS: f64 = 60_000.0;
/// Discoveries that may run at once.
pub const DEFAULT_CONCURRENCY: usize = 4;
/// Commands that may wait for the actor before a caller blocks.
const COMMAND_CAPACITY: usize = 256;
/// Refresh batches that may be outstanding at once.
pub(crate) const REFRESH_BATCH_LIMIT: usize = 256;
/// Callers that may wait on one flight, probe or removal.
pub(crate) const WAITER_LIMIT: usize = 1024;

/// A row registration's token. A session reports metadata under the token it saw, so a
/// replacement registration (even with the same login) cannot adopt an old session's
/// report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RegistrationToken(pub u64);

/// A monotonic millisecond clock, injected.
pub trait Clock: Send + Sync {
    fn now(&self) -> f64;
}

/// One-shot timers, injected: the returned cancel stops an armed callback.
pub trait Deadlines: Send + Sync {
    fn arm(&self, after_ms: f64, expire: Box<dyn Fn() + Send + Sync>) -> Cancel;
}

/// Stops an armed deadline. Cancelled on the thread that armed it.
pub type Cancel = Box<dyn FnOnce() + Send>;

/// Where a background flight runs. The actor spawns one task per flight, probe, listing or
/// deletion; tests collect the tasks instead of running them on a runtime.
pub trait Spawn: Send + Sync {
    fn spawn(&self, task: BoxFuture<'static, ()>);

    /// Runs whatever a port has queued. A real runtime already runs its tasks, so the
    /// default does nothing; the test collector polls its queue so a blocking caller can
    /// still make progress.
    fn drive(&self) {}
}

/// The connection-metadata probe (`revisionProbe`): a fingerprint of the CLI's own
/// connections, never a model list.
pub trait ConnectionProbe: Send + Sync {
    fn probe(
        &self,
        request: DiscoveryRequest,
        signal: crate::signals::Signal,
    ) -> BoxFuture<'static, Result<String, DiscoveryFailure>>;
}

/// A discovery request: the instance, with the configured binary in place of the default.
#[derive(Debug, Clone)]
pub struct DiscoveryRequest {
    pub instance: ModelInstance,
}

/// What a discovery port reports when it fails, never carrying provider prose onward.
pub type DiscoverResult = Result<DiscoveryOutcome, DiscoveryFailure>;

/// What a discovery port found.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryOutcome {
    pub models: Vec<CatalogModel>,
    pub sources: Option<Vec<SourceStatus>>,
    pub permission_modes: Option<Vec<Value>>,
}

/// Local diagnostics a discovery port learns as it runs; never stored or published.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryDiagnostics {
    pub cli_version: Option<String>,
    pub stage: Option<String>,
    pub rejected_models: Vec<RejectedModel>,
    pub source_failures: Vec<SourceFailure>,
    pub sources: Option<Vec<ace_protocol::generated::ModelSource>>,
}

#[derive(Debug, Clone)]
pub struct RejectedModel {
    pub index: usize,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct SourceFailure {
    pub source: String,
    pub reason: String,
    pub stage: Option<String>,
}

/// The callback a discovery port calls as it learns.
pub type DiagnosticSink = Arc<dyn Fn(DiscoveryDiagnostics) + Send + Sync>;

/// The discovery port: a provider's models, or its fixed failure.
pub trait CatalogDiscover: Send + Sync {
    fn discover(
        &self,
        request: DiscoveryRequest,
        signal: crate::signals::Signal,
        diagnostic: DiagnosticSink,
    ) -> BoxFuture<'static, DiscoverResult>;
}

/// One local log line about a discovery.
#[derive(Debug, Clone)]
pub struct ErrorReport {
    pub provider: ProviderKind,
    pub instance: String,
    pub error: DiscoveryError,
    pub source: Option<String>,
    pub source_label: Option<String>,
    pub duration_ms: f64,
    pub cli_version: Option<String>,
    pub stage: Option<String>,
    pub level: Option<String>,
    pub retry_in_ms: Option<f64>,
    pub reason: Option<String>,
    pub model_index: Option<usize>,
}

/// Where local log lines go. Never part of catalog state, storage or a client reply.
pub type OnError = Arc<dyn Fn(ErrorReport) + Send + Sync>;

/// A filter over registered instances (`ModelFilter`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelFilter {
    pub provider: Option<ProviderKind>,
    pub instance: Option<String>,
    pub acp_agent_id: Option<String>,
    pub installation_id: Option<String>,
    pub instance_id: Option<String>,
}

impl ModelFilter {
    pub fn provider(provider: ProviderKind) -> Self {
        Self {
            provider: Some(provider),
            ..Self::default()
        }
    }

    pub fn instance(instance: &str) -> Self {
        Self {
            instance: Some(instance.to_owned()),
            ..Self::default()
        }
    }
}

pub use types::{CatalogError, InstanceStatus, ModelListResult, RowStatus, StatusError};

/// What a registered row's admission guard does before a discovery starts.
pub type Admit = Arc<dyn Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// The ports and limits the catalog runs with.
pub struct CatalogOptions {
    pub storage: SharedStorage,
    pub discover: Arc<dyn CatalogDiscover>,
    pub clock: Arc<dyn Clock>,
    pub deadline: Arc<dyn Deadlines>,
    pub spawn: Arc<dyn Spawn>,
    pub instances: Vec<ModelInstance>,
    pub ttl_ms: f64,
    pub timeout_ms: f64,
    pub retry_ms: f64,
    pub random: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub concurrency: usize,
    pub preferences: Option<Arc<dyn Fn() -> Vec<ProviderConfig> + Send + Sync>>,
    pub acp_probe_interval_ms: f64,
    pub connection_check_ms: Option<f64>,
    pub revision_probe: Option<Arc<dyn ConnectionProbe>>,
    pub on_error: Option<OnError>,
}

impl CatalogOptions {
    pub fn new(
        storage: SharedStorage,
        discover: Arc<dyn CatalogDiscover>,
        clock: Arc<dyn Clock>,
        deadline: Arc<dyn Deadlines>,
        spawn: Arc<dyn Spawn>,
    ) -> Self {
        Self {
            storage,
            discover,
            clock,
            deadline,
            spawn,
            instances: Vec::new(),
            ttl_ms: DEFAULT_TTL_MS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            retry_ms: DEFAULT_RETRY_MS,
            random: Arc::new(|| 0.5),
            concurrency: DEFAULT_CONCURRENCY,
            preferences: None,
            acp_probe_interval_ms: DEFAULT_ACP_PROBE_INTERVAL_MS,
            connection_check_ms: None,
            revision_probe: None,
            on_error: None,
        }
    }

    pub fn instances(mut self, instances: Vec<ModelInstance>) -> Self {
        self.instances = instances;
        self
    }

    pub fn preferences(
        mut self,
        preferences: Arc<dyn Fn() -> Vec<ProviderConfig> + Send + Sync>,
    ) -> Self {
        self.preferences = Some(preferences);
        self
    }

    pub fn on_error(mut self, on_error: OnError) -> Self {
        self.on_error = Some(on_error);
        self
    }

    pub fn connection_check_ms(mut self, millis: f64) -> Self {
        self.connection_check_ms = Some(millis);
        self
    }
}

impl std::fmt::Debug for CatalogOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CatalogOptions")
            .field("instances", &self.instances.len())
            .field("ttl_ms", &self.ttl_ms)
            .field("timeout_ms", &self.timeout_ms)
            .field("retry_ms", &self.retry_ms)
            .field("concurrency", &self.concurrency)
            .finish_non_exhaustive()
    }
}

/// A discovery or invalidation running for one row.
#[derive(Clone, Debug)]
pub(crate) struct Flight {
    pub(crate) done: crate::signals::Gate,
    pub(crate) token: u64,
}

/// The connection metadata probe running for one row (`state.probe`).
#[derive(Clone, Debug)]
pub(crate) struct ProbeFlight {
    pub(crate) token: u64,
}

pub(crate) struct State {
    pub(crate) config: ModelInstance,
    pub(crate) permission_modes: Option<Vec<Value>>,
    pub(crate) admit: Option<Admit>,
    pub(crate) entry: Option<Arc<CacheEntry>>,
    pub(crate) error: Option<StatusError>,
    pub(crate) error_detail: Option<DiscoveryError>,
    pub(crate) dirty: bool,
    pub(crate) no_model_sources: Option<BTreeSet<String>>,
    pub(crate) unconfigured_at: Option<f64>,
    pub(crate) retry_at: f64,
    pub(crate) backoff: DiscoveryBackoff,
    pub(crate) connection_fingerprint: Option<String>,
    pub(crate) probe_retry_at: f64,
    pub(crate) settings_key: String,
    pub(crate) flight: Option<Flight>,
    pub(crate) flight_token: Option<u64>,
    pub(crate) probe_revision: Option<String>,
    pub(crate) probe: Option<ProbeFlight>,
    pub(crate) acp_due: bool,
    /// The registration this row's state belongs to.
    pub(crate) generation: u64,
    pub(crate) abort: Option<crate::signals::Signal>,
    pub(crate) view: Option<(String, Vec<CatalogModel>)>,
}

/// One removal another caller already started: its deletion, and the result every caller
/// that asked for the same id sees.
pub(crate) struct Removal {
    pub(crate) token: u64,
    pub(crate) waiters: Vec<Reply<Result<(), CatalogError>>>,
}

/// The revocation draining an instance, which outlives the registration it replaced.
pub(crate) struct Invalidation {
    pub(crate) token: u64,
    pub(crate) done: crate::signals::Gate,
    /// The turn place whose deletion this revocation runs, in the row's queue.
    pub(crate) place: u64,
}

pub(crate) struct Inner {
    pub(crate) states: BTreeMap<String, State>,
    pub(crate) order: Vec<String>,
    pub(crate) providers: BTreeMap<ProviderKind, Vec<String>>,
    pub(crate) persisted: BTreeMap<String, CacheEntry>,
    pub(crate) persisted_order: Vec<String>,
    pub(crate) deletions: crate::deletions::PendingDeletions,
    /// The places taken for each instance's stored choices, in the order they were accepted.
    pub(crate) turns: BTreeMap<String, Turns>,
    pub(crate) invalidating: BTreeMap<String, Vec<Invalidation>>,
    pub(crate) acp_loaded: BTreeSet<String>,
    pub(crate) acp_spacing: AcpProbeSpacing,
    pub(crate) closed: bool,
    pub(crate) active_flights: usize,
    pub(crate) probes: usize,
    pub(crate) session_writes: usize,
    pub(crate) invalidations: usize,
    pub(crate) next_generation: u64,
    pub(crate) row_flights: BTreeMap<String, Vec<Flight>>,
    pub(crate) listeners: BTreeMap<u64, Arc<dyn Fn(ModelFilter) + Send + Sync>>,
    pub(crate) installations: BTreeMap<String, String>,
    pub(crate) connections_checked_at: Option<f64>,
    pub(crate) observers: usize,
    pub(crate) flight_token: u64,
    pub(crate) removals: BTreeMap<String, Removal>,
}

/// Catalog-owned work waiting for its place in an instance's queue.
pub(crate) enum PendingOp {
    SessionWrite(Box<SessionWrite>),
    PermissionWrite(Box<PermissionWrite>),
    FlightCommit(Box<flights::Commit>),
    Invalidation { token: u64 },
}

/// The catalog a daemon serves: a handle that only sends commands to the actor.
#[derive(Clone)]
pub struct Catalog {
    pub(crate) sender: Arc<std::sync::mpsc::SyncSender<Envelope>>,
    pub(crate) options: Arc<CatalogOptions>,
    /// A successful close is final: every later call answers with this result.
    closed: Arc<Mutex<Option<Result<(), CatalogError>>>>,
    join: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    /// The ids the actor held, so a closed catalog still answers `has_instance`.
    instances: Arc<Mutex<BTreeSet<String>>>,
}

impl std::fmt::Debug for Catalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Catalog").finish_non_exhaustive()
    }
}

fn check_durations(options: &CatalogOptions) -> Result<(), CatalogError> {
    for duration in [options.ttl_ms, options.timeout_ms, options.retry_ms] {
        if !duration.is_finite() || duration < 1.0 {
            return Err(CatalogError::Duration);
        }
    }
    if !(1..=64).contains(&options.concurrency) {
        return Err(CatalogError::Concurrency);
    }
    Ok(())
}

impl Catalog {
    /// Opens the catalog over its stored rows, starts the actor, and registers the
    /// caller's instances.
    pub fn new(options: CatalogOptions) -> Result<Self, CatalogError> {
        check_durations(&options)?;
        let spacing = AcpProbeSpacing::new(options.acp_probe_interval_ms)
            .map_err(|_| CatalogError::Duration)?;
        let mut storage = options.storage.clone();
        let stored = storage::load(&mut storage)?;
        if stored.len() > crate::cache::MAX_PERSISTED_INSTANCES {
            return Err(CatalogError::TooManyCachedInstances);
        }
        let instances = options.instances.clone();
        let storage = options.storage.clone();
        let limiter = crate::signals::Limiter::new(options.concurrency);
        let inner = Inner {
            states: BTreeMap::new(),
            order: Vec::new(),
            providers: BTreeMap::new(),
            persisted: BTreeMap::new(),
            persisted_order: Vec::new(),
            deletions: crate::deletions::PendingDeletions::new(),
            turns: BTreeMap::new(),
            invalidating: BTreeMap::new(),
            acp_loaded: BTreeSet::new(),
            acp_spacing: spacing,
            closed: false,
            active_flights: 0,
            probes: 0,
            session_writes: 0,
            invalidations: 0,
            next_generation: 0,
            row_flights: BTreeMap::new(),
            listeners: BTreeMap::new(),
            installations: BTreeMap::new(),
            connections_checked_at: None,
            observers: 0,
            flight_token: 0,
            removals: BTreeMap::new(),
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(COMMAND_CAPACITY);
        let sender = Arc::new(sender);
        let options = Arc::new(options);
        // Work the actor owns reports on its own unbounded queue; the actor keeps only a
        // weak name of the callers' mailbox, so dropping every handle ends it.
        let (completions, completions_receiver) = std::sync::mpsc::channel();
        let reporter = commands::Reporter {
            completions,
            commands: Arc::downgrade(&sender),
        };
        let closed = Arc::new(Mutex::new(None));
        let instance_ids = Arc::new(Mutex::new(BTreeSet::new()));
        let lane = storage_lane::StorageLane::new(storage.clone(), reporter.clone());
        let actor = actor::Actor::new(
            inner,
            stored,
            options.clone(),
            limiter,
            reporter,
            lane,
            actor::Shared {
                close_result: closed.clone(),
                instance_ids: instance_ids.clone(),
            },
        )?;
        let join = Arc::new(Mutex::new(Some(
            std::thread::Builder::new()
                .name("ace-model-catalog".to_owned())
                .spawn(move || actor.run(receiver, completions_receiver))
                .map_err(|_| CatalogError::Closed)?,
        )));
        let catalog = Self {
            sender,
            options,
            closed,
            join: join.clone(),
            instances: instance_ids,
        };
        for instance in instances {
            if let Err(error) = catalog.register_instance(instance, None) {
                // A construction that fails leaves no thread behind: closing the mailbox
                // ends the actor, and the join proves it is gone before the error returns.
                drop(catalog);
                if let Some(handle) = join
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    let _ = handle.join();
                }
                return Err(error);
            }
        }
        Ok(catalog)
    }

    pub fn options(&self) -> &CatalogOptions {
        &self.options
    }

    /// Sends one command and blocks for its reply. The actor finishes the work even when
    /// this call never returns, because a dropped receiver is not a cancellation.
    pub(crate) fn ask<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Option<T> {
        let (reply, receiver) = futures::channel::oneshot::channel();
        let (ack, ack_receiver) = futures::channel::oneshot::channel();
        {
            self.sender
                .send(commands::Envelope {
                    command: make(reply),
                    ack: Some(ack),
                })
                .ok()?;
        }
        self.wait_ack(ack_receiver)?;
        self.wait_sync(receiver)
    }

    /// Blocks until the actor has taken the command. The actor never awaits inside a
    /// handler, so this is bounded by one handler and does not run spawned work.
    fn wait_ack(&self, mut receiver: futures::channel::oneshot::Receiver<()>) -> Option<()> {
        loop {
            match receiver.try_recv() {
                Ok(Some(())) => return Some(()),
                Ok(None) => std::thread::yield_now(),
                Err(_) => return None,
            }
        }
    }

    /// Blocks until `receiver` answers. Every blocking reply is immediate; work that
    /// needs spawned tasks is awaited by `request`, never by a synchronous method.
    fn wait_sync<T>(&self, mut receiver: futures::channel::oneshot::Receiver<T>) -> Option<T> {
        loop {
            match receiver.try_recv() {
                Ok(Some(value)) => return Some(value),
                Ok(None) => std::thread::yield_now(),
                Err(_) => return None,
            }
        }
    }

    pub(crate) async fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Option<T> {
        let (reply, receiver) = futures::channel::oneshot::channel();
        let (ack, ack_receiver) = futures::channel::oneshot::channel();
        {
            self.sender
                .send(commands::Envelope {
                    command: make(reply),
                    ack: Some(ack),
                })
                .ok()?;
        }
        // The acknowledgement makes the first poll mean what the TypeScript's synchronous
        // queue meant: the command has been taken, not merely queued. It is a hand-off
        // bounded by one handler (the actor never blocks inside a command); the reply,
        // which may wait on discovery or storage, is awaited without blocking the thread.
        self.wait_ack(ack_receiver)?;
        receiver.await.ok()
    }

    /// Sends a command and waits until the actor handled it, for fire-and-forget calls.
    pub(crate) fn tell(&self, make: impl FnOnce(Reply<()>) -> Command) {
        let (reply, _) = futures::channel::oneshot::channel();
        let (ack, ack_receiver) = futures::channel::oneshot::channel();
        let sent = {
            self.sender.send(commands::Envelope {
                command: make(reply),
                ack: Some(ack),
            })
        };
        if sent.is_ok() {
            let _ = self.wait_ack(ack_receiver);
        }
    }

    #[allow(dead_code)]
    pub(crate) fn revision(&self, config: &ModelInstance) -> String {
        let rows = self
            .options
            .preferences
            .as_ref()
            .map(|preferences| preferences())
            .unwrap_or_default();
        let configuration =
            crate::preferences::provider_configuration(&rows, config.provider, Some(&config.id));
        revision_of(config, configuration.binary_path.as_deref())
    }

    /// A page of rows and every selected instance's status.
    pub fn list(
        &self,
        filter: ModelFilter,
        offset: usize,
        limit: usize,
    ) -> Result<ModelListResult, CatalogError> {
        if offset > 40_960 || !(1..=100).contains(&limit) {
            return Err(CatalogError::InvalidListOptions);
        }
        self.ask(|reply| Command::List {
            filter,
            offset,
            limit,
            reply,
        })
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// The model a role spec names, having asked for stale rows to refresh.
    pub fn resolve(&self, spec: &RoleSpec) -> Result<Resolution, String> {
        self.ask(|reply| Command::Resolve {
            spec: spec.clone(),
            cached: false,
            reply,
        })
        .unwrap_or_else(|| Err("Catalog closed".to_owned()))
    }

    /// The same resolution over retained choices, without scheduling discovery.
    pub fn resolve_cached(&self, spec: &RoleSpec) -> Result<Resolution, String> {
        self.ask(|reply| Command::Resolve {
            spec: spec.clone(),
            cached: true,
            reply,
        })
        .unwrap_or_else(|| Err("Catalog closed".to_owned()))
    }

    pub fn has_provider(&self, provider: ProviderKind) -> bool {
        self.ask(|reply| Command::HasProvider { provider, reply })
            .unwrap_or(false)
    }

    pub fn has_instance(&self, instance: &str) -> bool {
        match self.ask(|reply| Command::HasInstance {
            id: instance.to_owned(),
            reply,
        }) {
            Some(value) => value,
            // The actor is gone after a close; the rows it held are still an answer.
            None => self
                .instances
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(instance),
        }
    }

    /// The instance as registered now, for a session to report into later.
    pub fn registered(&self, id: &str) -> Option<ModelInstance> {
        self.ask(|reply| Command::Registered {
            id: id.to_owned(),
            reply,
        })
        .flatten()
    }

    /// The instance as registered now, with the token that owns this registration. A
    /// session carries the token so its report can never land on a replacement row.
    pub fn registration(&self, id: &str) -> Option<(ModelInstance, RegistrationToken)> {
        self.ask(|reply| Command::Registration {
            id: id.to_owned(),
            reply,
        })
        .flatten()
    }

    /// Subscribes to row changes. The limit is 4096 listeners.
    pub fn listen(
        &self,
        listener: Arc<dyn Fn(ModelFilter) + Send + Sync>,
    ) -> Result<Cancel, CatalogError> {
        let token = self
            .ask(|reply| Command::Listen { listener, reply })
            .unwrap_or(Err(CatalogError::Closed))?;
        let sender = self.sender.clone();
        Ok(Box::new(move || {
            let _ = sender.send(Envelope {
                command: Command::Unlisten { token },
                ack: None,
            });
        }))
    }

    /// Ordinary catalog changes retain usable choices while discovery replaces them.
    pub fn mark_stale(&self, filter: ModelFilter) -> Result<(), CatalogError> {
        self.ask(|reply| Command::MarkStale { filter, reply })
            .unwrap_or(Err(CatalogError::Closed))
    }

    /// Registers an instance, restoring a compatible cached row.
    pub fn register_instance(
        &self,
        input: ModelInstance,
        admit: Option<Admit>,
    ) -> Result<(), CatalogError> {
        self.ask(|reply| Command::Register {
            input,
            admit,
            reply,
        })
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// A sign-in changed: the old account's choices are gone immediately.
    pub async fn login_changed(
        &self,
        instance: &str,
        revision: &str,
        sign_in_method: Option<Option<String>>,
    ) -> Result<Vec<InstanceStatus>, CatalogError> {
        let immediate = self
            .request(|reply| Command::LoginChanged {
                instance: instance.to_owned(),
                revision: revision.to_owned(),
                sign_in_method,
                reply,
            })
            .await
            .unwrap_or(Err(CatalogError::Closed));
        match immediate? {
            Some(statuses) => Ok(statuses),
            None => self.refresh(ModelFilter::instance(instance)).await,
        }
    }

    /// Removes a row: state, cached choices, and a flush of in-flight discovery.
    pub async fn remove_instance(&self, instance: &str) -> Result<(), CatalogError> {
        self.request(|reply| Command::Remove {
            instance: instance.to_owned(),
            reply,
        })
        .await
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// Account-change boundary: revoke choices immediately, then delete them.
    pub async fn invalidate(&self, filter: ModelFilter) -> Result<(), CatalogError> {
        self.request(|reply| Command::Invalidate { filter, reply })
            .await
            .unwrap_or(Err(CatalogError::Closed))
    }

    /// Settings changed: rows whose effective configuration changed are fenced and refreshed.
    pub fn configuration_changed(&self) {
        self.tell(|reply| Command::ConfigurationChanged { reply });
    }

    /// A provider's installed version changed for this runtime.
    pub fn installation_changed(&self, provider: ProviderKind, version: &str, runtime: &str) {
        self.tell(|reply| Command::InstallationChanged {
            provider,
            version: version.to_owned(),
            runtime: runtime.to_owned(),
            reply,
        });
    }

    /// The statuses an explicit refresh reports.
    pub async fn refresh(&self, filter: ModelFilter) -> Result<Vec<InstanceStatus>, CatalogError> {
        self.request(|reply| Command::Refresh {
            filter,
            mode: RefreshMode::All,
            reply,
        })
        .await
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// The person asked for one row's models (Load models).
    pub async fn load(&self, instance: &str) -> Result<Vec<InstanceStatus>, CatalogError> {
        self.request(|reply| Command::Refresh {
            filter: ModelFilter::instance(instance),
            mode: RefreshMode::Load(instance.to_owned()),
            reply,
        })
        .await
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// Waits for rows that never loaded, or loaded empty and are due.
    pub async fn load_missing(
        &self,
        filter: ModelFilter,
    ) -> Result<Vec<InstanceStatus>, CatalogError> {
        self.request(|reply| Command::Refresh {
            filter,
            mode: RefreshMode::Missing,
            reply,
        })
        .await
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// Discovers one row, sharing a flight that is already running.
    #[allow(dead_code)]
    pub(crate) async fn refresh_state(&self, id: &str, cause: RefreshCause) -> InstanceStatus {
        self.request(|reply| Command::RefreshState {
            id: id.to_owned(),
            cause,
            reply,
        })
        .await
        .unwrap_or_else(|| empty_status(id))
    }

    /// Explicit refresh: resets the pause and owns the result through settings changes.
    #[allow(dead_code)]
    pub(crate) async fn refresh_current(&self, id: &str, cause: RefreshCause) -> InstanceStatus {
        self.mark_not_paused(id);
        let mut revision = self
            .registered(id)
            .map(|config| self.revision(&config))
            .unwrap_or_default();
        let mut status = self.refresh_state(id, cause).await;
        loop {
            if !self.has_instance(id) {
                break;
            }
            let Some(config) = self.registered(id) else {
                break;
            };
            let current = self.revision(&config);
            let flying = self
                .ask(|reply| Command::HasFlight {
                    id: id.to_owned(),
                    reply,
                })
                .unwrap_or(false);
            if !flying && current == revision {
                break;
            }
            revision = current;
            status = self.refresh_state(id, cause).await;
        }
        status
    }

    #[allow(dead_code)]
    fn mark_not_paused(&self, id: &str) {
        self.tell(|reply| Command::ResetPause {
            id: id.to_owned(),
            reply,
        });
    }

    /// Metadata from an already authorized session. No process or inference starts.
    pub async fn update_from_session(
        &self,
        input: ModelInstance,
        token: RegistrationToken,
        metadata: &Value,
    ) -> Result<(), CatalogError> {
        self.request(|reply| Command::UpdateSession {
            input,
            token,
            metadata: metadata.clone(),
            reply,
        })
        .await
        .unwrap_or(Err(CatalogError::Closed))
    }

    /// A session's reported modes survive a restart: written onto the cached entry.
    pub fn update_permission_modes(
        &self,
        instance: &str,
        token: RegistrationToken,
        modes: Vec<Value>,
    ) {
        self.tell(|reply| Command::UpdateModes {
            instance: instance.to_owned(),
            token,
            modes,
            reply,
        });
    }

    /// Test plumbing: the caller replies the actor retains for later work.
    #[allow(dead_code)]
    pub(crate) fn retained_replies(&self) -> usize {
        self.ask(|reply| Command::RetainedReplies { reply })
            .unwrap_or(0)
    }

    #[allow(dead_code)]
    pub(crate) fn pending_session_writes(&self) -> usize {
        self.ask(|reply| Command::PendingWork { reply })
            .unwrap_or(0)
    }

    #[allow(dead_code)]
    pub(crate) async fn quiesce(&self) {
        let _ = self.request(|reply| Command::Quiesce { reply }).await;
    }

    #[allow(dead_code)]
    pub(crate) fn inspect_row(&self, id: &str) -> (Option<String>, bool) {
        self.ask(|reply| Command::Inspect {
            id: id.to_owned(),
            reply,
        })
        .unwrap_or((None, false))
    }

    /// Shuts the catalog down: abort flights, drain every spawned task, flush deletions,
    /// close storage. A successful close is final and repeated calls answer with it; a
    /// failed one leaves the catalog usable so a later call can retry the deletions.
    pub async fn close(&self) -> Result<(), CatalogError> {
        // Only a successful close is final. A failed one left durable deletion markers
        // behind, so a later call retries instead of replaying the failure forever.
        if matches!(
            self.closed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref(),
            Some(Ok(()))
        ) {
            return Ok(());
        }
        let result = match self.request(|reply| Command::Close { reply }).await {
            Some(result) => result,
            None => self
                .closed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .unwrap_or(Err(CatalogError::Closed)),
        };
        if result.is_ok() {
            // The actor left its loop after recording the result; joining it proves every
            // row, timer and storage handle it owned is gone before close returns.
            if let Some(handle) = self
                .join
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
            {
                let _ = handle.join();
            }
        }
        result
    }

    /// Poll only CLI connection metadata; unchanged metadata never starts discovery.
    pub async fn reconcile_connections(&self) -> Result<(), CatalogError> {
        let Some(ids) = self.request(|reply| Command::ReconcileIds { reply }).await else {
            return Err(CatalogError::Closed);
        };
        let Some(ids) = ids else {
            return Ok(());
        };
        for id in ids {
            // Shutdown skips an account rather than failing the loop that already ran;
            // an actor that is gone for the same reason ends the loop quietly.
            match self.request(|reply| Command::Probe { id, reply }).await {
                Some(Ok(())) | Some(Err(CatalogError::Closed)) | None => {}
                Some(Err(error)) => return Err(error),
            }
        }
        Ok(())
    }

    /// While a client watches the catalog, re-check connections every interval.
    pub fn observe_connections(&self) -> CancelHandle {
        let token = self.ask(|reply| Command::Observe { reply }).unwrap_or(None);
        CancelHandle::new(self.clone(), token)
    }

    /// Takes this instance's place in its queue, before waiting for the places before it.
    #[allow(dead_code)]
    pub(crate) fn reserve_turn(&self, id: &str) -> turns::Turn {
        let token = self
            .ask(|reply| Command::ReserveTurn {
                id: id.to_owned(),
                reply,
            })
            .unwrap_or_default();
        turns::Turn::new(self.clone(), id.to_owned(), token)
    }

    /// A place that is already its turn.
    #[allow(dead_code)]
    pub(crate) async fn hold_turn(&self, id: &str) -> turns::Turn {
        let Some((token, granted)) = self
            .request(|reply| Command::HoldTurn {
                id: id.to_owned(),
                reply,
            })
            .await
        else {
            return turns::Turn::detached(self.clone(), id.to_owned());
        };
        let mut pending = turns::PendingTurn {
            catalog: self.clone(),
            id: id.to_owned(),
            token,
            armed: true,
        };
        let _ = granted.await;
        pending.armed = false;
        turns::Turn::new(self.clone(), id.to_owned(), token)
    }

    #[allow(dead_code)]
    pub(crate) fn settle_turn(&self, id: &str, token: u64) {
        self.tell(|reply| Command::SettleTurn {
            id: id.to_owned(),
            token,
            reply,
        });
    }
}

pub(crate) fn empty_status(id: &str) -> InstanceStatus {
    InstanceStatus {
        provider: ProviderKind::Acp,
        instance: id.to_owned(),
        acp_agent_id: None,
        installation_id: None,
        instance_id: None,
        refreshed_at: None,
        last_refreshed_at: None,
        enabled: Some(true),
        status: None,
        error_detail: None,
        sources: None,
        stale: true,
        refreshing: false,
        error: None,
        permission_modes: None,
        model_probe: None,
    }
}

/// The instance's row as the person would read it, from the cached entry alone.
pub(crate) fn models_of(options: &CatalogOptions, state: &mut State) -> Vec<CatalogModel> {
    let preferences = options
        .preferences
        .as_ref()
        .map(|preferences| preferences())
        .unwrap_or_default();
    let config = crate::preferences::provider_configuration(
        &preferences,
        state.config.provider,
        Some(&state.config.id),
    );
    let key = format!(
        "{}|{}|{}|{:?}",
        state.settings_key,
        state
            .entry
            .as_ref()
            .map(|entry| entry.revision.clone())
            .unwrap_or_default(),
        state
            .entry
            .as_ref()
            .map(|entry| entry.refreshed_at)
            .unwrap_or_default(),
        state
            .entry
            .as_ref()
            .map(|entry| entry.models.len())
            .unwrap_or_default()
    );
    if let Some((cached, rows)) = &state.view
        && *cached == key
    {
        return rows.clone();
    }
    let rows: Vec<CatalogModel> = state
        .entry
        .as_ref()
        .map(|entry| {
            let owned: Vec<CatalogModel> = entry.models.iter().map(|row| (**row).clone()).collect();
            configured_models(&owned, state.config.provider, &state.config.id, &config)
        })
        .unwrap_or_default();
    state.view = Some((key, rows.clone()));
    rows
}

pub(crate) fn stale(options: &CatalogOptions, state: &State) -> bool {
    let now = options.clock.now();
    if let Some(unconfigured_at) = state.unconfigured_at
        && !state.dirty
    {
        return now - unconfigured_at >= options.ttl_ms;
    }
    state.dirty
        || state.error.is_some()
        || state
            .entry
            .as_ref()
            .and_then(|entry| entry.sources.as_ref())
            .is_some_and(|sources| sources.iter().any(crate::sources::source_failed))
        || state.entry.is_none()
        || state
            .entry
            .as_ref()
            .is_some_and(|entry| now - entry.refreshed_at >= options.ttl_ms)
}

pub(crate) fn status_of(options: &CatalogOptions, inner: &Inner, state: &State) -> InstanceStatus {
    let refreshing = state.flight.is_some() && state.error_detail.is_none();
    let is_stale = stale(options, state);
    let enabled = enabled_of(options, &state.config);
    let now = options.clock.now();
    let permission_modes = state.permission_modes.clone().or_else(|| {
        state
            .entry
            .as_ref()
            .and_then(|entry| entry.permission_modes.clone())
    });
    let sources = state
        .entry
        .as_ref()
        .and_then(|entry| entry.sources.as_ref())
        .map(|sources| {
            sources
                .iter()
                .map(|source| {
                    let mut status = source.clone();
                    if let Some(label) = source_label(&state.config)
                        && status.source.kind == ace_protocol::generated::ModelSourceKind::Account
                    {
                        status.source.label = label.to_owned().into();
                    }
                    status.status = if refreshing {
                        SourceState::Refreshing
                    } else if state.error.is_some()
                        || state.dirty
                        || state.entry.is_none()
                        || now
                            - (status
                                .last_refreshed_at
                                .or_else(|| state.entry.as_ref().map(|entry| entry.refreshed_at))
                                .unwrap_or(now))
                            >= options.ttl_ms
                        || crate::sources::source_failed(&status)
                    {
                        SourceState::Stale
                    } else {
                        SourceState::Fresh
                    };
                    if state.error_detail.is_some() || status.error.is_some() {
                        let failure = DiscoveryFailure {
                            code: state
                                .error_detail
                                .as_ref()
                                .map(|detail| detail.code.as_str().to_owned())
                                .or_else(|| {
                                    status
                                        .error
                                        .as_ref()
                                        .map(|error| error.code.as_str().to_owned())
                                }),
                            ..DiscoveryFailure::default()
                        };
                        status.error = Some(crate::failures::discovery_error(
                            Some(&failure),
                            FailureCode::DiscoveryFailed,
                            &crate::failures::ErrorContext {
                                provider: Some(&state.config.provider.to_string()),
                                source: Some(&status.source.id.0),
                                backend: None,
                            },
                        ));
                    }
                    status
                })
                .collect()
        });
    let _ = inner;
    InstanceStatus {
        provider: state.config.provider,
        instance: state.config.id.clone(),
        acp_agent_id: state.config.acp_agent_id.clone(),
        installation_id: state.config.installation_id.clone(),
        instance_id: state.config.instance_id.clone(),
        refreshed_at: state.entry.as_ref().map(|entry| entry.refreshed_at),
        last_refreshed_at: state.entry.as_ref().map(|entry| entry.refreshed_at),
        enabled: Some(enabled),
        status: Some(if refreshing {
            RowStatus::Refreshing
        } else if is_stale {
            RowStatus::Stale
        } else {
            RowStatus::Fresh
        }),
        error_detail: state.error_detail.clone(),
        sources,
        stale: is_stale,
        refreshing,
        error: state.error,
        permission_modes,
        model_probe: match crate::gate::reported_probe(
            state.config.model_probe,
            state.entry.is_some(),
        ) {
            Some(ace_models::instance::ModelProbe::Automatic) => Some("automatic".to_owned()),
            Some(ace_models::instance::ModelProbe::OnRequest) => Some("on-request".to_owned()),
            None => None,
        },
    }
}

fn enabled_of(options: &CatalogOptions, config: &ModelInstance) -> bool {
    let rows = options
        .preferences
        .as_ref()
        .map(|preferences| preferences())
        .unwrap_or_default();
    crate::preferences::provider_configuration(&rows, config.provider, Some(&config.id)).enabled
        != Some(false)
}

pub(crate) fn selection(inner: &Inner, filter: &ModelFilter) -> Vec<String> {
    let matches = |state: &State| {
        filter
            .provider
            .is_none_or(|provider| state.config.provider == provider)
            && filter
                .acp_agent_id
                .as_ref()
                .is_none_or(|id| state.config.acp_agent_id.as_ref() == Some(id))
            && filter
                .installation_id
                .as_ref()
                .is_none_or(|id| state.config.installation_id.as_ref() == Some(id))
            && filter
                .instance_id
                .as_ref()
                .is_none_or(|id| state.config.instance_id.as_ref() == Some(id))
    };
    if let Some(instance) = &filter.instance {
        return match inner.states.get(instance) {
            Some(state) if matches(state) => vec![instance.clone()],
            _ => Vec::new(),
        };
    }
    let ids: Vec<String> = match filter.provider {
        Some(provider) => inner.providers.get(&provider).cloned().unwrap_or_default(),
        None => inner.order.clone(),
    };
    ids.into_iter()
        .filter(|id| inner.states.get(id).is_some_and(&matches))
        .collect()
}

fn source_label(config: &ModelInstance) -> Option<&str> {
    config.label.as_deref()
}

/// The revision a cached row is keyed by (`cacheRevision`).
pub(crate) fn cache_revision(instance: &ModelInstance) -> String {
    if instance.provider == ProviderKind::Opencode {
        return sha256_json(&serde_json::json!([
            instance.login_revision,
            "connected-providers-v1"
        ]));
    }
    if instance.provider == ProviderKind::Acp {
        return sha256_json(&serde_json::json!([
            instance.login_revision,
            instance.acp_agent_id,
            instance.installation_id,
            instance.instance_id,
            instance.profile_revision,
        ]));
    }
    instance.login_revision.clone()
}

/// What a cached row belongs to; an ACP row's folder is no part of it (`identityRevision`).
pub(crate) fn identity_revision(instance: &ModelInstance) -> String {
    sha256_json(&serde_json::json!([
        instance.id,
        instance.provider,
        instance.login_revision,
        instance.backend.map(|backend| match backend {
            Backend::Acp => "acp",
            Backend::CursorSdk => "cursor-sdk",
        }),
        instance.home_dir,
        if instance.provider == ProviderKind::Acp {
            None
        } else {
            Some(instance.cwd.clone())
        },
        instance.acp_agent_id,
        instance.installation_id,
        instance.instance_id,
        instance.profile_revision,
    ]))
}

pub(crate) fn revision_of(instance: &ModelInstance, binary_path: Option<&str>) -> String {
    match (binary_path, instance.installation_version.as_deref()) {
        (Some(path), _) => sha256_json(&serde_json::json!([
            cache_revision(instance),
            path,
            instance.installation_version
        ])),
        (None, Some(version)) => {
            sha256_json(&serde_json::json!([cache_revision(instance), version]))
        }
        (None, None) => cache_revision(instance),
    }
}

pub(crate) fn sha256_json(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let text = serde_json::to_string(value).unwrap_or_default();
    let mut digest = Sha256::new();
    digest.update(text.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The validation `ModelInstance.parse` performs.
pub(crate) fn validate_instance(instance: &ModelInstance) -> Result<(), CatalogError> {
    let label = |value: &str| (1..=256).contains(&value.chars().count());
    if !label(&instance.id) || !label(&instance.login_revision) {
        return Err(CatalogError::InvalidInstance);
    }
    if let Some(value) = &instance.label
        && !label(value)
    {
        return Err(CatalogError::InvalidInstance);
    }
    // The sign-in method is its own bound: 1 to 128 code points (`ModelInstance.parse`).
    if let Some(method) = &instance.sign_in_method
        && !(1..=128).contains(&method.chars().count())
    {
        return Err(CatalogError::InvalidInstance);
    }
    for value in [
        instance.acp_agent_id.as_deref(),
        instance.installation_id.as_deref(),
        instance.instance_id.as_deref(),
        instance.profile_revision.as_deref(),
        instance.installation_version.as_deref(),
        instance.home_dir.as_deref(),
        Some(instance.cwd.as_str()),
        Some(instance.executable.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        if value.chars().count() > 4096 {
            return Err(CatalogError::InvalidInstance);
        }
    }
    if instance.args.len() > 64
        || instance.args.iter().any(|arg| arg.chars().count() > 4096)
        || instance.cwd.is_empty()
        || instance.unset_env.len() > 64
    {
        return Err(CatalogError::InvalidInstance);
    }
    let sdk = instance.backend == Some(Backend::CursorSdk);
    if sdk {
        if instance.provider != ProviderKind::Cursor || instance.home_dir.is_none() {
            return Err(CatalogError::InvalidInstance);
        }
    } else if instance.executable.is_empty() {
        return Err(CatalogError::InvalidInstance);
    }
    Ok(())
}

/// `connectionRevision`: only non-secret provider identities and availability are hashed.
pub(crate) fn flights_connection_revision(
    provider: ProviderKind,
    models: &[CatalogModel],
    sources: Option<&[SourceStatus]>,
) -> String {
    let values: Vec<String> = if provider == ProviderKind::Opencode {
        let mut values: Vec<String> = sources
            .unwrap_or_default()
            .iter()
            .filter(|status| status.source.requires_auth != Some(false))
            .map(|status| {
                serde_json::to_string(&serde_json::json!([
                    status.source.kind,
                    status.source.id,
                    status.source.label,
                    status.source.service
                ]))
                .unwrap_or_default()
            })
            .collect();
        values.sort();
        values
    } else {
        let mut values: Vec<String> = models
            .iter()
            .map(|model| {
                format!(
                    "{}/{}",
                    model
                        .native_provider_id
                        .as_ref()
                        .map(|provider| provider.0.0.as_str())
                        .unwrap_or(""),
                    model.id.0
                )
            })
            .collect();
        values.sort();
        values
    };
    sha256_json(&Value::Array(
        values.into_iter().map(Value::String).collect(),
    ))
}

/// Whether `token` still owns row `id`: a re-registration bumps the generation.
pub(crate) fn owns(inner: &Inner, id: &str, token: u64) -> bool {
    inner
        .states
        .get(id)
        .is_some_and(|state| state.generation == token)
}
