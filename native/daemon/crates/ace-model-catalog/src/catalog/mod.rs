// SPDX-License-Identifier: Apache-2.0
//! The catalog's state machine (`packages/models/src/catalog.ts`).
//!
//! One row per registered instance, cached rows read at startup, lazy discovery on reads,
//! explicit refresh, account invalidation and session writes. Everything the machine
//! cannot control is a port: [`CatalogDiscover`] for a provider's models, [`Clock`] and
//! [`Deadlines`] for time, [`Spawn`] for background flights and [`crate::cache::CatalogStorage`]
//! for persistence. The TypeScript's single-threaded queue is kept by a mutex around
//! state, taken only between awaits, so a flight never blocks a read.

mod refresh;
mod registration;
#[cfg(test)]
mod tests;
mod writes;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use ace_models::instance::{Backend, ModelInstance};
use ace_protocol::generated::{CatalogModel, ProviderKind};
use futures::future::LocalBoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::backoff::DiscoveryBackoff;
use crate::cache::{CacheEntry, CacheError, SharedStorage};
use crate::failures::{DiscoveryError, DiscoveryFailure, FailureCode};
use crate::gate::{AcpProbeSpacing, RefreshCause};
use crate::preferences::{ProviderConfig, configured_models};
use crate::resolve::{Resolution, RoleSpec, resolve_model};
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

/// Where a background flight runs. The daemon spawns on its local runtime; tests collect
/// the tasks. Flights stay on the catalog's thread, so the port is not `Send`.
pub trait Spawn {
    fn spawn(&self, task: LocalBoxFuture<'static, ()>);
}

/// The connection-metadata probe (`revisionProbe`): a fingerprint of the CLI's own
/// connections, never a model list.
pub trait ConnectionProbe: Send + Sync {
    fn probe(
        &self,
        request: DiscoveryRequest,
        signal: crate::signals::Signal,
    ) -> LocalBoxFuture<'static, Result<String, DiscoveryFailure>>;
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
    ) -> LocalBoxFuture<'static, DiscoverResult>;
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

/// The state a row's discovery is in, as clients read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    Fresh,
    Refreshing,
    Stale,
}

/// The short error a status carries (`ModelInstanceStatus.error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusError {
    DiscoveryFailed,
    Timeout,
    PersistenceFailed,
}

/// One row as clients read it (`ModelInstanceStatus`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceStatus {
    pub provider: ProviderKind,
    pub instance: String,
    #[serde(
        rename = "acpAgentId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub acp_agent_id: Option<String>,
    #[serde(
        rename = "installationId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub installation_id: Option<String>,
    #[serde(
        rename = "instanceId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub instance_id: Option<String>,
    #[serde(
        rename = "refreshedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub refreshed_at: Option<f64>,
    #[serde(
        rename = "lastRefreshedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_refreshed_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<RowStatus>,
    #[serde(
        rename = "errorDetail",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub error_detail: Option<DiscoveryError>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sources: Option<Vec<SourceStatus>>,
    pub stale: bool,
    pub refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<StatusError>,
    #[serde(
        rename = "permissionModes",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub permission_modes: Option<Vec<Value>>,
    #[serde(
        rename = "modelProbe",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub model_probe: Option<String>,
}

/// A page of rows and the statuses of the instances they came from (`ModelListResult`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListResult {
    pub models: Vec<CatalogModel>,
    pub instances: Vec<InstanceStatus>,
    #[serde(
        rename = "nextOffset",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub next_offset: Option<usize>,
}

/// A catalog request that cannot be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    Closed,
    InvalidInstance,
    InstanceLimit,
    RemovalDraining,
    InstanceRemovalCapacity,
    ListenerLimit,
    Concurrency,
    Duration,
    TooManyCachedInstances,
    Cache(CacheError),
    SessionActivityCapacity,
    SessionGenerationChanged,
    InvalidationCapacity,
    DiscoverySourceLimit,
    DiscoveryCleanupLimit,
    InvalidListOptions,
    UnknownInstance,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Closed => "Catalog closed",
            Self::InvalidInstance => "Invalid model instance",
            Self::InstanceLimit => "Instance limit reached",
            Self::RemovalDraining => "Instance removal is still draining",
            Self::InstanceRemovalCapacity => "Instance removal capacity reached",
            Self::ListenerLimit => "Catalog listener limit reached",
            Self::Concurrency => "Invalid concurrency",
            Self::Duration => "Invalid catalog duration",
            Self::TooManyCachedInstances => "Too many cached instances",
            Self::Cache(error) => return error.fmt(f),
            Self::SessionActivityCapacity => "Session metadata capacity reached",
            Self::SessionGenerationChanged => "Session model generation changed",
            Self::InvalidationCapacity => "Invalidation capacity reached",
            Self::DiscoverySourceLimit => "Discovery source limit reached",
            Self::DiscoveryCleanupLimit => "Discovery cleanup limit reached",
            Self::InvalidListOptions => "Invalid model list options",
            Self::UnknownInstance => "Unknown instance",
        })
    }
}

impl std::error::Error for CatalogError {}

impl From<CacheError> for CatalogError {
    fn from(error: CacheError) -> Self {
        Self::Cache(error)
    }
}

/// What a registered row's admission guard does before a discovery starts.
pub type Admit =
    Arc<dyn Fn() -> futures::future::BoxFuture<'static, Result<(), String>> + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

/// One unit of catalog work that close waits for, registered independently of any row:
/// a flight, an invalidation, a removal or an accepted write.
pub(crate) struct OwnedWork {
    pub(crate) catalog: Catalog,
    pub(crate) gate: crate::signals::Gate,
}

impl OwnedWork {
    pub(crate) fn register(catalog: &Catalog) -> Self {
        let gate = crate::signals::Gate::new();
        catalog.with_inner(|inner| inner.owned.push(gate.clone()));
        Self {
            catalog: catalog.clone(),
            gate,
        }
    }
}

impl Drop for OwnedWork {
    fn drop(&mut self) {
        self.catalog.with_inner(|inner| {
            inner.owned.retain(|known| !known.same(&self.gate));
        });
        // Settles any close that was already waiting on this unit of work.
        self.gate.open();
    }
}

/// The connection metadata probe running for one row (`state.probe`).
#[derive(Clone, Debug)]
pub(crate) struct ProbeFlight {
    pub(crate) done: crate::signals::Gate,
}

/// A discovery or invalidation running for one row: waiters share its gate.
#[derive(Clone, Debug)]
pub(crate) struct Flight {
    pub done: crate::signals::Gate,
    pub token: u64,
    /// The registration the flight was installed for.
    pub generation: u64,
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
    pub(crate) invalidating: Option<Flight>,
    pub(crate) flight: Option<Flight>,
    pub(crate) flight_token: Option<u64>,
    pub(crate) probe_revision: Option<String>,
    /// The connection metadata probe running for this row, shared by every poll.
    pub(crate) probe: Option<ProbeFlight>,
    pub(crate) acp_due: bool,
    /// The registration this row's state belongs to.
    pub(crate) generation: u64,
    pub(crate) abort: Option<crate::signals::Signal>,
    pub(crate) view: Option<(String, Vec<CatalogModel>)>,
}

pub(crate) struct Inner {
    pub(crate) states: BTreeMap<String, State>,
    pub(crate) order: Vec<String>,
    pub(crate) providers: BTreeMap<ProviderKind, Vec<String>>,
    pub(crate) persisted: BTreeMap<String, CacheEntry>,
    pub(crate) persisted_order: Vec<String>,
    pub(crate) deletions: crate::deletions::PendingDeletions,
    /// Deletions a registration does not carry: a write for the same id waits for them,
    /// so a replacement row is never deleted by the login it replaced.
    pub(crate) deletion_gates: BTreeMap<String, crate::signals::Gate>,
    pub(crate) acp_loaded: BTreeSet<String>,
    pub(crate) acp_spacing: AcpProbeSpacing,
    pub(crate) closed: bool,
    /// The close attempt running now, and the result of the last finished one.
    pub(crate) close_gate: Option<crate::signals::Gate>,
    pub(crate) close_result: Option<Result<(), CatalogError>>,
    pub(crate) active_flights: usize,
    pub(crate) probes: usize,
    pub(crate) session_writes: usize,
    pub(crate) invalidations: usize,
    pub(crate) write_tails: BTreeMap<String, crate::signals::Gate>,
    pub(crate) accepted_writes: Vec<crate::signals::Gate>,
    pub(crate) next_generation: u64,
    pub(crate) owned: Vec<crate::signals::Gate>,
    /// The flights running for each instance, whatever row replaced them.
    pub(crate) row_flights: BTreeMap<String, Vec<crate::signals::Gate>>,
    pub(crate) probe_signals: Vec<crate::signals::Signal>,
    pub(crate) listeners: Vec<Arc<dyn Fn(ModelFilter) + Send + Sync>>,
    pub(crate) installations: BTreeMap<String, String>,
    pub(crate) connections_checked_at: Option<f64>,
    pub(crate) observers: usize,
    pub(crate) observed_check: Option<Cancel>,
    pub(crate) flight_token: u64,
    pub(crate) removals: BTreeSet<String>,
}

/// The catalog a daemon serves.
// The catalog is thread-local: its flights and writes are `LocalBoxFuture`s, and the
// daemon drives it from the thread that owns it.
#[allow(clippy::arc_with_non_send_sync)]
#[derive(Clone)]
pub struct Catalog {
    pub(crate) inner: Arc<Mutex<Inner>>,
    pub(crate) options: Arc<CatalogOptions>,
    pub(crate) limiter: crate::signals::Limiter,
    pub(crate) storage: SharedStorage,
}

impl std::fmt::Debug for Catalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Catalog")
            .field("instances", &lock(&self.inner).order.len())
            .finish_non_exhaustive()
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
    /// Opens the catalog over its stored rows and registers the caller's instances.
    pub fn new(options: CatalogOptions) -> Result<Self, CatalogError> {
        check_durations(&options)?;
        let spacing = AcpProbeSpacing::new(options.acp_probe_interval_ms)
            .map_err(|_| CatalogError::Duration)?;
        let mut storage = options.storage.clone();
        let stored = storage.load()?;
        if stored.len() > crate::cache::MAX_PERSISTED_INSTANCES {
            return Err(CatalogError::TooManyCachedInstances);
        }
        let storage = options.storage.clone();
        let inner = Inner {
            states: BTreeMap::new(),
            order: Vec::new(),
            providers: BTreeMap::new(),
            persisted: BTreeMap::new(),
            persisted_order: Vec::new(),
            deletions: crate::deletions::PendingDeletions::new(storage.clone()),
            deletion_gates: BTreeMap::new(),
            acp_loaded: BTreeSet::new(),
            acp_spacing: spacing,
            closed: false,
            close_gate: None,
            close_result: None,
            active_flights: 0,
            probes: 0,
            session_writes: 0,
            invalidations: 0,
            write_tails: BTreeMap::new(),
            accepted_writes: Vec::new(),
            next_generation: 0,
            owned: Vec::new(),
            row_flights: BTreeMap::new(),
            probe_signals: Vec::new(),
            listeners: Vec::new(),
            installations: BTreeMap::new(),
            connections_checked_at: None,
            observers: 0,
            observed_check: None,
            flight_token: 0,
            removals: BTreeSet::new(),
        };
        let instances = options.instances.clone();
        #[allow(clippy::arc_with_non_send_sync)]
        let options = Arc::new(options);
        let catalog = Self {
            inner: Arc::new(Mutex::new(inner)),
            limiter: crate::signals::Limiter::new(options.concurrency),
            options: options.clone(),
            storage,
        };
        for entry in stored {
            if entry.provider == ProviderKind::Acp {
                lock(&catalog.inner)
                    .acp_loaded
                    .insert(entry.instance.clone());
            }
            let owned: Vec<CatalogModel> = entry.models.iter().map(|row| (**row).clone()).collect();
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
            let mut inner = lock(&catalog.inner);
            inner.persisted_order.push(entry.instance.clone());
            inner.persisted.insert(entry.instance.clone(), entry);
        }
        for instance in instances {
            catalog.register_instance(instance, None)?;
        }
        Ok(catalog)
    }

    pub fn options(&self) -> &CatalogOptions {
        &self.options
    }

    pub(crate) fn now(&self) -> f64 {
        self.options.clock.now()
    }

    pub(crate) fn with_inner<T>(&self, read: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = lock(&self.inner);
        read(&mut inner)
    }

    pub(crate) fn configuration(&self, config: &ModelInstance) -> ProviderConfig {
        let rows = self
            .options
            .preferences
            .as_ref()
            .map(|preferences| preferences())
            .unwrap_or_default();
        crate::preferences::provider_configuration(&rows, config.provider, Some(&config.id))
    }

    pub(crate) fn enabled(&self, config: &ModelInstance) -> bool {
        self.configuration(config).enabled != Some(false)
    }

    pub(crate) fn revision(&self, config: &ModelInstance) -> String {
        let path = self.configuration(config).binary_path;
        revision_of(config, path.as_deref())
    }

    pub(crate) fn cache_revision(&self, config: &ModelInstance) -> String {
        cache_revision(config)
    }

    /// The instance's row as the person would read it, from the cached entry alone.
    pub(crate) fn models_of(&self, state: &mut State) -> Vec<CatalogModel> {
        let preferences = self
            .options
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
                let owned: Vec<CatalogModel> =
                    entry.models.iter().map(|row| (**row).clone()).collect();
                configured_models(&owned, state.config.provider, &state.config.id, &config)
            })
            .unwrap_or_default();
        state.view = Some((key, rows.clone()));
        rows
    }

    pub(crate) fn selection(&self, filter: &ModelFilter) -> Vec<String> {
        let inner = lock(&self.inner);
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

    pub(crate) fn revalidate(&self, ids: &[String], cause: RefreshCause) {
        refresh::revalidate(self, ids, cause);
    }

    pub(crate) fn stale(&self, state: &State) -> bool {
        let now = self.now();
        if let Some(unconfigured_at) = state.unconfigured_at
            && !state.dirty
        {
            return now - unconfigured_at >= self.options.ttl_ms;
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
                .is_some_and(|entry| now - entry.refreshed_at >= self.options.ttl_ms)
    }

    pub(crate) fn status(&self, state: &State) -> InstanceStatus {
        let refreshing = state.flight.is_some() && state.error_detail.is_none();
        let stale = self.stale(state);
        let enabled = self.enabled(&state.config);
        let now = self.now();
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
                            && status.source.kind
                                == ace_protocol::generated::ModelSourceKind::Account
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
                                    .or_else(|| {
                                        state.entry.as_ref().map(|entry| entry.refreshed_at)
                                    })
                                    .unwrap_or(now))
                                >= self.options.ttl_ms
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
            } else if stale {
                RowStatus::Stale
            } else {
                RowStatus::Fresh
            }),
            error_detail: state.error_detail.clone(),
            sources,
            stale,
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
        let ids = self.selection(&filter);
        self.check_connections();
        self.revalidate(&ids, RefreshCause::Read);
        let mut models = Vec::new();
        let mut skipped = offset;
        let mut remaining = limit + 1;
        for id in &ids {
            let rows = self
                .with_inner(|inner| inner.states.get_mut(id).map(|state| self.models_of(state)));
            let Some(rows) = rows else { continue };
            if skipped >= rows.len() {
                skipped -= rows.len();
                continue;
            }
            let end = rows.len().min(skipped + remaining);
            for row in &rows[skipped..end] {
                models.push(row.clone());
                remaining -= 1;
            }
            skipped = 0;
            if remaining == 0 {
                break;
            }
        }
        let more = models.len() > limit;
        if more {
            models.pop();
        }
        let instances = self.with_inner(|inner| {
            ids.iter()
                .filter_map(|id| inner.states.get(id).map(|state| self.status(state)))
                .collect()
        });
        Ok(ModelListResult {
            models,
            instances,
            next_offset: more.then_some(offset + limit),
        })
    }

    /// The model a role spec names, having asked for stale rows to refresh.
    pub fn resolve(&self, spec: &RoleSpec) -> Result<Resolution, String> {
        let filter = ModelFilter {
            provider: spec.provider,
            instance: spec.instance.clone(),
            ..ModelFilter::default()
        };
        let ids = self.selection(&filter);
        self.check_connections();
        self.revalidate(&ids, RefreshCause::Read);
        self.resolve_selected(spec, &ids)
    }

    /// The same resolution over retained choices, without scheduling discovery.
    pub fn resolve_cached(&self, spec: &RoleSpec) -> Result<Resolution, String> {
        let filter = ModelFilter {
            provider: spec.provider,
            instance: spec.instance.clone(),
            ..ModelFilter::default()
        };
        let ids = self.selection(&filter);
        self.resolve_selected(spec, &ids)
    }

    fn resolve_selected(&self, spec: &RoleSpec, ids: &[String]) -> Result<Resolution, String> {
        let mut rows = Vec::new();
        for id in ids {
            if let Some(models) =
                self.with_inner(|inner| inner.states.get_mut(id).map(|state| self.models_of(state)))
            {
                rows.extend(models);
            }
        }
        let mut stale: BTreeMap<String, bool> = BTreeMap::new();
        self.with_inner(|inner| {
            for (id, state) in &inner.states {
                stale.insert(id.clone(), self.stale(state));
            }
        });
        resolve_model(spec, &rows, |instance| {
            stale.get(instance).copied().unwrap_or(true)
        })
    }

    pub fn has_provider(&self, provider: ProviderKind) -> bool {
        self.with_inner(|inner| {
            inner
                .providers
                .get(&provider)
                .is_some_and(|ids| !ids.is_empty())
        })
    }

    pub fn has_instance(&self, instance: &str) -> bool {
        self.with_inner(|inner| inner.states.contains_key(instance))
    }

    /// The instance as registered now, for a session to report into later.
    pub fn registered(&self, id: &str) -> Option<ModelInstance> {
        self.with_inner(|inner| inner.states.get(id).map(|state| state.config.clone()))
    }

    /// Subscribes to row changes. The limit is 4096 listeners.
    pub fn listen(
        &self,
        listener: Arc<dyn Fn(ModelFilter) + Send + Sync>,
    ) -> Result<Cancel, CatalogError> {
        let mut inner = lock(&self.inner);
        if inner.listeners.len() >= 4096 {
            return Err(CatalogError::ListenerLimit);
        }
        inner.listeners.push(listener.clone());
        let inner_ref = self.inner.clone();
        Ok(Box::new(move || {
            let mut inner = lock(&inner_ref);
            inner
                .listeners
                .retain(|current| !Arc::ptr_eq(current, &listener));
        }))
    }

    /// Ordinary catalog changes retain usable choices while discovery replaces them.
    pub fn mark_stale(&self, filter: ModelFilter) -> Result<(), CatalogError> {
        let changes = self.with_inner(|inner| {
            if inner.closed {
                return Err(CatalogError::Closed);
            }
            let mut changes = Vec::new();
            for id in selection_locked(inner, &filter) {
                let Some(state) = inner.states.get_mut(&id) else {
                    continue;
                };
                if state.config.provider == ProviderKind::Acp {
                    continue;
                }
                state.dirty = true;
                state.probe_retry_at = 0.0;
                state.backoff.reset();
                state.retry_at = 0.0;
                changes.push(state.config.clone());
            }
            Ok(changes)
        })?;
        for config in &changes {
            self.notify_config(config);
        }
        Ok(())
    }

    pub(crate) fn notify_config(&self, config: &ModelInstance) {
        let listeners = lock(&self.inner).listeners.clone();
        let filter = ModelFilter {
            provider: Some(config.provider),
            instance: Some(config.id.clone()),
            ..ModelFilter::default()
        };
        for listener in listeners {
            listener(filter.clone());
        }
    }

    /// Waits for a deletion another account change scheduled for this row, so a write
    /// never recreates a row that deletion is about to remove.
    pub(crate) async fn await_deletion(&self, id: &str) {
        let barrier = self.with_inner(|inner| inner.deletion_gates.get(id).cloned());
        if let Some(barrier) = barrier {
            barrier.wait().await;
        }
    }

    /// Completes a deletion this write would otherwise recreate.
    pub(crate) fn finish_deletion(&self, id: &str) -> Result<(), CatalogError> {
        if self.with_inner(|inner| inner.deletions.has(id)) {
            self.with_inner(|inner| inner.deletions.remove(id))?;
        }
        Ok(())
    }

    /// Shuts the catalog down: abort flights, drain every owned unit of work, flush
    /// deletions, close storage. Concurrent callers share one attempt and its result.
    pub async fn close(&self) -> Result<(), CatalogError> {
        enum Plan {
            Done(Result<(), CatalogError>),
            Wait(crate::signals::Gate),
            Drain {
                work: Vec<crate::signals::Gate>,
                observed: Option<Cancel>,
            },
        }
        let plan = self.with_inner(|inner| {
            if let Some(result) = &inner.close_result {
                if result.is_ok() {
                    return Plan::Done(Ok(()));
                }
                // Storage was never closed: a later close retries the deletions.
                inner.close_result = None;
            }
            if let Some(gate) = &inner.close_gate {
                return Plan::Wait(gate.clone());
            }
            inner.closed = true;
            inner.listeners.clear();
            // Every probe is aborted before anything is awaited, so a probe waiting on
            // its own signal returns and its gate opens.
            for signal in inner.probe_signals.drain(..) {
                signal.abort();
            }
            let observed = inner.observed_check.take();
            for state in inner.states.values() {
                if let Some(abort) = &state.abort {
                    abort.abort();
                }
            }
            // The work registry, not the rows: a removal or flush that outlived its row
            // still holds close until it settles.
            let mut work = inner.owned.clone();
            work.extend(inner.write_tails.values().cloned());
            work.append(&mut inner.accepted_writes);
            inner.close_gate = Some(crate::signals::Gate::new());
            Plan::Drain { work, observed }
        });
        match plan {
            Plan::Done(result) => result,
            Plan::Wait(gate) => {
                gate.wait().await;
                self.with_inner(|inner| inner.close_result.clone().unwrap_or(Ok(())))
            }
            Plan::Drain { work, observed, .. } => {
                if let Some(cancel) = observed {
                    cancel();
                }
                for unit in work {
                    unit.wait().await;
                }
                // Accepted session writes are drained before storage closes.
                for tail in
                    self.with_inner(|inner| inner.write_tails.values().cloned().collect::<Vec<_>>())
                {
                    tail.wait().await;
                }
                let result = self.finish_close();
                self.with_inner(|inner| {
                    inner.close_result = Some(result.clone());
                    if let Some(gate) = inner.close_gate.take() {
                        gate.open();
                    }
                });
                result
            }
        }
    }

    /// The last steps of a close, once every unit of work settled.
    fn finish_close(&self) -> Result<(), CatalogError> {
        let deletions = self.with_inner(|inner| inner.deletions.flush());
        deletions?;
        let mut storage = self.storage.clone();
        storage.close().map_err(CatalogError::Cache)?;
        Ok(())
    }
}

fn selection_locked(inner: &Inner, filter: &ModelFilter) -> Vec<String> {
    if let Some(instance) = &filter.instance {
        let matches = inner.states.get(instance).is_some_and(|state| {
            filter
                .provider
                .is_none_or(|provider| state.config.provider == provider)
                && filter
                    .acp_agent_id
                    .as_ref()
                    .is_none_or(|value| state.config.acp_agent_id.as_ref() == Some(value))
                && filter
                    .installation_id
                    .as_ref()
                    .is_none_or(|value| state.config.installation_id.as_ref() == Some(value))
                && filter
                    .instance_id
                    .as_ref()
                    .is_none_or(|value| state.config.instance_id.as_ref() == Some(value))
        });
        return if matches {
            vec![instance.clone()]
        } else {
            Vec::new()
        };
    }
    let ids: Vec<String> = match filter.provider {
        Some(provider) => inner.providers.get(&provider).cloned().unwrap_or_default(),
        None => inner.order.clone(),
    };
    ids.into_iter()
        .filter(|id| {
            inner.states.get(id).is_some_and(|state| {
                filter
                    .acp_agent_id
                    .as_ref()
                    .is_none_or(|value| state.config.acp_agent_id.as_ref() == Some(value))
                    && filter
                        .installation_id
                        .as_ref()
                        .is_none_or(|value| state.config.installation_id.as_ref() == Some(value))
                    && filter
                        .instance_id
                        .as_ref()
                        .is_none_or(|value| state.config.instance_id.as_ref() == Some(value))
            })
        })
        .collect()
}

fn source_label(config: &ModelInstance) -> Option<&str> {
    config.label.as_deref()
}

/// The revision a cached row is keyed by (`cacheRevision`).
fn cache_revision(instance: &ModelInstance) -> String {
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
fn identity_revision(instance: &ModelInstance) -> String {
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

fn revision_of(instance: &ModelInstance, binary_path: Option<&str>) -> String {
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

/// One state's fresh status for the flight that ended.
/// The ids a filter selects, for a caller already holding the lock.
pub(crate) fn selection_for(inner: &mut Inner, filter: &ModelFilter) -> Vec<String> {
    selection_locked(inner, filter)
}

/// Whether `token` still owns row `id`: a re-registration bumps the generation.
pub(crate) fn owns(inner: &Inner, id: &str, token: u64) -> bool {
    inner
        .states
        .get(id)
        .is_some_and(|state| state.generation == token)
}

pub(crate) fn fresh_status(catalog: &Catalog, id: &str) -> Option<InstanceStatus> {
    catalog.with_inner(|inner| inner.states.get(id).map(|state| catalog.status(state)))
}
