// SPDX-License-Identifier: Apache-2.0
//! Discovery flights, explicit refreshes and connection probes, decided by the actor.
//!
//! A flight's task runs admission and the provider call; the actor installs the flight,
//! arms its deadline once admission passed, fences every result against the row and
//! revision it started under, and commits results in the instance's turn order.

use std::sync::Arc;

use ace_models::instance::ModelInstance;
use ace_protocol::generated::ProviderKind;
use futures::FutureExt;

use crate::catalog::actor::{Actor, RefreshBatch, TaskKind};
use crate::catalog::commands::{Command, Reply};
use crate::catalog::flights::{self, Job};
use crate::catalog::{
    Catalog, CatalogError, DiscoveryFailure, Flight, InstanceStatus, ModelFilter, ProbeFlight,
    RefreshMode, empty_status, models_of, selection, stale, status_of,
};
use crate::failures::FailureCode;
use crate::gate::{AcpRowFacts, RefreshCause, acp_probe_allowed};
use crate::resolve::{Resolution, RoleSpec, resolve_model};
use crate::signals::{Gate, Signal};

pub(crate) enum FlightStart {
    Started(u64),
    Running(u64),
    Skipped,
}

impl Actor {
    /// A handle for work the actor spawned, while the caller that caused it still holds
    /// the catalog. The actor itself keeps only a weak name of the mailbox.
    pub(crate) fn catalog_handle(&self) -> Option<Catalog> {
        Some(Catalog {
            sender: self.commands.upgrade()?,
            options: self.options.clone(),
            closed: Arc::new(std::sync::Mutex::new(None)),
            join: Arc::new(std::sync::Mutex::new(None)),
            instances: self.instance_ids.clone(),
        })
    }

    pub(crate) fn start_flight(&mut self, id: &str, cause: RefreshCause) -> FlightStart {
        let now = self.now();
        let Some(state) = self.inner.states.get(id) else {
            return FlightStart::Skipped;
        };
        if let Some(flight) = &state.flight {
            return FlightStart::Running(flight.token);
        }
        if self.inner.closed {
            return FlightStart::Skipped;
        }
        let facts = AcpRowFacts {
            loaded: state.entry.is_some(),
            loaded_before: self.inner.acp_loaded.contains(id) || state.entry.is_some(),
            due: state.acp_due,
        };
        if state.config.provider == ProviderKind::Acp
            && !acp_probe_allowed(state.config.model_probe, facts, cause)
        {
            return FlightStart::Skipped;
        }
        if !self.enabled(&state.config) || now < state.retry_at {
            return FlightStart::Skipped;
        }
        if self.inner.active_flights >= 64 {
            self.fail(
                id,
                None,
                FailureCode::DiscoveryFailed,
                &crate::catalog::actor::FailureReport {
                    started_at: now,
                    diagnostics: &crate::catalog::DiscoveryDiagnostics::default(),
                    revision: None,
                    token: None,
                },
            );
            return FlightStart::Skipped;
        }
        let config = state.config.clone();
        if config.provider == ProviderKind::Acp {
            if !self.inner.acp_spacing.admit(id, now) {
                return FlightStart::Skipped;
            }
            if let Some(state) = self.inner.states.get_mut(id) {
                state.acp_due = false;
            }
        }
        let revision = self.revision(&config);
        let abort = Signal::new();
        self.inner.flight_token += 1;
        let token = self.inner.flight_token;
        self.inner.active_flights += 1;
        let flight = Flight {
            done: Gate::new(),
            token,
        };
        if let Some(state) = self.inner.states.get_mut(id) {
            state.probe_revision = Some(revision.clone());
            state.abort = Some(abort.clone());
            state.flight = Some(flight.clone());
            state.flight_token = Some(token);
        }
        self.inner
            .row_flights
            .entry(id.to_owned())
            .or_default()
            .push(flight.clone());
        let admit = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.admit.clone());
        let pending = self
            .inner
            .invalidating
            .get(id)
            .and_then(|pending| pending.last())
            .map(|pending| pending.done.clone());
        // The deadline is armed at admission, before the limiter or a guard can hang: a
        // guard that never answers must not hold a discovery slot past the deadline.
        self.arm_flight_deadline(id, token);
        let request = with_binary_path(&config, self.configuration(&config).binary_path.as_deref());
        self.notify_id(id);
        self.spawn(
            TaskKind::Flight {
                id: id.to_owned(),
                token,
            },
            flights::run(
                self.reporter.clone(),
                self.options.clone(),
                self.limiter.clone(),
                Job {
                    id: id.to_owned(),
                    token,
                    request,
                    signal: abort,
                    admit,
                    pending,
                },
            )
            .boxed(),
        );
        FlightStart::Started(token)
    }

    pub(crate) fn refresh_state(
        &mut self,
        id: &str,
        cause: RefreshCause,
        reply: Reply<InstanceStatus>,
    ) {
        let status = self.status(id).unwrap_or_else(|| empty_status(id));
        if !self.inner.states.contains_key(id) {
            let _ = reply.send(status);
            return;
        }
        match self.start_flight(id, cause) {
            FlightStart::Started(token) | FlightStart::Running(token) => {
                // A spawner that refuses the task settles it before this point; never
                // wait on a flight that is already over.
                if !self.flight_alive(id, token) {
                    let status = self.status(id).unwrap_or_else(|| empty_status(id));
                    let _ = reply.send(status);
                } else {
                    let waiters = self.flight_waiters.entry(token).or_default();
                    waiters.retain(|waiter| !waiter.is_canceled());
                    if waiters.len() >= crate::catalog::WAITER_LIMIT {
                        // At the bound the caller gets the row as it stands now.
                        let status = self.status(id).unwrap_or_else(|| empty_status(id));
                        let _ = reply.send(status);
                    } else if !reply.is_canceled() {
                        waiters.push(reply);
                    }
                }
            }
            FlightStart::Skipped => {
                let _ = reply.send(status);
            }
        }
    }

    pub(crate) fn refresh(
        &mut self,
        filter: ModelFilter,
        mode: RefreshMode,
        reply: Reply<Result<Vec<InstanceStatus>, CatalogError>>,
    ) {
        if self.inner.closed {
            let _ = reply.send(Err(CatalogError::Closed));
            return;
        }
        if self.refresh_batches.len() >= crate::catalog::REFRESH_BATCH_LIMIT {
            let _ = reply.send(Err(CatalogError::Busy));
            return;
        }
        let mut ids = selection(&self.inner, &filter);
        let mut cause = RefreshCause::Background;
        match &mode {
            RefreshMode::All => {}
            RefreshMode::Load(instance) => {
                if !self.inner.states.contains_key(instance) {
                    let _ = reply.send(Ok(Vec::new()));
                    return;
                }
                ids = vec![instance.clone()];
                let is_acp = self
                    .inner
                    .states
                    .get(instance)
                    .is_some_and(|state| state.config.provider == ProviderKind::Acp);
                if !is_acp {
                    cause = RefreshCause::Background;
                } else {
                    cause = RefreshCause::Request;
                }
            }
            RefreshMode::Missing => {
                cause = RefreshCause::Read;
                ids.retain(|id| {
                    self.inner.states.get(id).is_some_and(|state| {
                        state.entry.is_none()
                            || (state
                                .entry
                                .as_ref()
                                .is_some_and(|entry| entry.models.is_empty())
                                && (state.flight.is_some() || stale(&self.options, state)))
                    })
                });
            }
        }
        let loading_acp = match &mode {
            RefreshMode::Load(instance) => self
                .inner
                .states
                .get(instance)
                .is_some_and(|state| state.config.provider == ProviderKind::Acp),
            _ => false,
        };
        if !loading_acp {
            for id in &ids {
                self.reset_pause(id);
            }
        }
        self.next_batch += 1;
        let batch = self.next_batch;
        let mut pending = std::collections::BTreeMap::new();
        for id in &ids {
            let is_acp = self
                .inner
                .states
                .get(id)
                .is_some_and(|state| state.config.provider == ProviderKind::Acp);
            if is_acp && !loading_acp {
                if let Some(state) = self.inner.states.get_mut(id) {
                    state.acp_due = true;
                    state.dirty = true;
                }
                self.notify_id(id);
                continue;
            }
            match self.start_flight(id, cause) {
                // Only a flight that is still running may be waited on: a spawner that
                // refused the task already settled it (and this batch is not registered
                // yet, so its settlement could not answer it).
                FlightStart::Started(token) | FlightStart::Running(token) => {
                    if self.flight_alive(id, token) {
                        pending.insert(id.clone(), token);
                    }
                }
                FlightStart::Skipped => {}
            }
        }
        if pending.is_empty() {
            let statuses = ids.iter().filter_map(|id| self.status(id)).collect();
            let _ = reply.send(Ok(statuses));
            return;
        }
        self.refresh_batches.insert(
            batch,
            RefreshBatch {
                ids,
                pending,
                reply,
            },
        );
    }

    fn reset_pause(&mut self, id: &str) {
        if let Some(state) = self.inner.states.get_mut(id) {
            state.probe_retry_at = 0.0;
            state.backoff.reset();
            state.retry_at = 0.0;
        }
    }

    pub(crate) fn revalidate(&mut self, ids: &[String], cause: RefreshCause) {
        if self.inner.closed {
            return;
        }
        let due: Vec<String> = ids
            .iter()
            .filter(|id| {
                self.inner.states.get(*id).is_some_and(|state| {
                    stale(&self.options, state) && self.now() >= state.retry_at
                })
            })
            .cloned()
            .collect();
        for id in due {
            self.start_flight(&id, cause);
        }
    }

    pub(crate) fn check_connections(&mut self) {
        let Some(interval) = self.options.connection_check_ms else {
            return;
        };
        if self.inner.closed {
            return;
        }
        let now = self.now();
        if self
            .inner
            .connections_checked_at
            .is_some_and(|last| now - last < interval)
        {
            return;
        }
        self.inner.connections_checked_at = Some(now);
        let Some(catalog) = self.catalog_handle() else {
            return;
        };
        self.spawn(
            TaskKind::Other,
            Box::pin(async move {
                let _ = catalog.reconcile_connections().await;
            }),
        );
    }

    pub(crate) fn list(
        &mut self,
        filter: ModelFilter,
        offset: usize,
        limit: usize,
        reply: Reply<Result<crate::catalog::ModelListResult, CatalogError>>,
    ) {
        let ids = selection(&self.inner, &filter);
        self.check_connections();
        self.revalidate(&ids, RefreshCause::Read);
        let mut models = Vec::new();
        let mut skipped = offset;
        let mut remaining = limit + 1;
        for id in &ids {
            let rows = self
                .inner
                .states
                .get_mut(id)
                .map(|state| models_of(&self.options, state));
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
        let instances = ids
            .iter()
            .filter_map(|id| {
                self.inner
                    .states
                    .get(id)
                    .map(|state| status_of(&self.options, &self.inner, state))
            })
            .collect();
        let _ = reply.send(Ok(crate::catalog::ModelListResult {
            models,
            instances,
            next_offset: more.then_some(offset + limit),
        }));
    }

    pub(crate) fn resolve(
        &mut self,
        spec: RoleSpec,
        cached: bool,
        reply: Reply<Result<Resolution, String>>,
    ) {
        let filter = ModelFilter {
            provider: spec.provider,
            instance: spec.instance.clone(),
            ..ModelFilter::default()
        };
        let ids = selection(&self.inner, &filter);
        if !cached {
            self.check_connections();
            self.revalidate(&ids, RefreshCause::Read);
        }
        let mut rows = Vec::new();
        for id in &ids {
            if let Some(models) = self
                .inner
                .states
                .get_mut(id)
                .map(|state| models_of(&self.options, state))
            {
                rows.extend(models);
            }
        }
        let mut is_stale = std::collections::BTreeMap::new();
        for (id, state) in &self.inner.states {
            is_stale.insert(id.clone(), stale(&self.options, state));
        }
        let result = resolve_model(&spec, &rows, |instance| {
            is_stale.get(instance).copied().unwrap_or(true)
        });
        let _ = reply.send(result);
    }

    pub(crate) fn probe(&mut self, id: &str, reply: Reply<Result<(), CatalogError>>) {
        if self.inner.closed {
            // Shutdown skips this account; it is not a caller-visible failure.
            let _ = reply.send(Ok(()));
            return;
        }
        if let Some(token) = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.probe.as_ref().map(|probe| probe.token))
        {
            // A poll joins the probe this registration started, even while it hangs.
            let waiters = self.probe_waiters.entry(token).or_default();
            waiters.retain(|waiter| !waiter.is_canceled());
            if waiters.len() >= crate::catalog::WAITER_LIMIT {
                let _ = reply.send(Err(CatalogError::Busy));
            } else if !reply.is_canceled() {
                waiters.push(reply);
            }
            return;
        }
        if self.inner.probes >= 64 {
            let _ = reply.send(Ok(()));
            return;
        }
        let now = self.now();
        let Some(config) = self.inner.states.get(id).map(|state| state.config.clone()) else {
            let _ = reply.send(Ok(()));
            return;
        };
        let blocked = self.inner.states.get(id).is_some_and(|state| {
            state.flight.is_some() || now < state.probe_retry_at.max(state.retry_at)
        });
        if blocked {
            let _ = reply.send(Ok(()));
            return;
        }
        let Some(probe) = self.options.revision_probe.clone() else {
            let _ = reply.send(Ok(()));
            return;
        };
        let revision = self.revision(&config);
        let generation = self
            .inner
            .states
            .get(id)
            .map(|state| state.generation)
            .unwrap_or_default();
        self.next_probe += 1;
        let token = self.next_probe;
        let signal = Signal::new();
        if let Some(state) = self.inner.states.get_mut(id) {
            state.probe = Some(ProbeFlight { token });
        }
        self.inner.probes += 1;
        self.probe_signals.insert(token, signal.clone());
        self.probe_rows.insert(token, id.to_owned());
        if !reply.is_canceled() {
            self.probe_waiters.entry(token).or_default().push(reply);
        }
        let reporter = self.reporter.clone();
        let cancel = self.options.deadline.arm(
            self.options.timeout_ms,
            Box::new({
                let deadline_id = id.to_owned();
                move || {
                    reporter.report(Command::ProbeDeadline {
                        id: deadline_id.clone(),
                        token,
                    });
                }
            }),
        );
        self.probe_cancels.insert(token, cancel);
        let request = with_binary_path(&config, self.configuration(&config).binary_path.as_deref());
        let id = id.to_owned();
        let reporter = self.reporter.clone();
        self.spawn(
            TaskKind::Probe {
                id: id.clone(),
                token,
            },
            Box::pin(async move {
                let inflight = probe.probe(
                    crate::catalog::DiscoveryRequest { instance: request },
                    signal.clone(),
                );
                let result = match futures::future::select(inflight, Box::pin(signal.wait())).await
                {
                    futures::future::Either::Left((result, _)) => Some(result),
                    futures::future::Either::Right(((), _)) => None,
                };
                reporter.report(Command::ProbeOutcome {
                    id,
                    token,
                    generation,
                    revision,
                    started_at: now,
                    result,
                });
            }),
        );
    }

    pub(crate) fn probe_deadline(&mut self, id: &str, token: u64) {
        let matches = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.probe.as_ref())
            .is_some_and(|probe| probe.token == token)
            || self.probe_rows.contains_key(&token);
        if !matches {
            return;
        }
        self.timed_out_probes.insert(token);
        if let Some(signal) = self.probe_signals.get(&token) {
            signal.abort();
        }
    }

    pub(crate) fn probe_outcome(
        &mut self,
        id: &str,
        token: u64,
        generation: u64,
        revision: &str,
        started_at: f64,
        result: Option<Result<String, DiscoveryFailure>>,
    ) {
        let owns_row = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.probe.as_ref())
            .is_some_and(|probe| probe.token == token);
        let counted = self.probe_rows.remove(&token).is_some();
        if !owns_row && !counted {
            return;
        }
        if owns_row && let Some(state) = self.inner.states.get_mut(id) {
            state.probe = None;
        }
        if counted {
            self.inner.probes = self.inner.probes.saturating_sub(1);
        }
        if let Some(cancel) = self.probe_cancels.remove(&token) {
            cancel();
        }
        self.probe_signals.remove(&token);
        let fired = self.timed_out_probes.remove(&token);
        let aborted = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.abort.as_ref())
            .is_some_and(Signal::is_aborted);
        let waiters = self.probe_waiters.remove(&token).unwrap_or_default();
        if fired {
            self.fail(
                id,
                None,
                FailureCode::Timeout,
                &crate::catalog::actor::FailureReport {
                    started_at,
                    diagnostics: &crate::catalog::DiscoveryDiagnostics::default(),
                    revision: None,
                    token: None,
                },
            );
            if let Some(state) = self.inner.states.get_mut(id) {
                state.probe_retry_at = state.retry_at;
            }
            self.notify_id(id);
            for waiter in waiters {
                let _ = waiter.send(Ok(()));
            }
            return;
        }
        if aborted || result.is_none() {
            for waiter in waiters {
                let _ = waiter.send(Ok(()));
            }
            return;
        }
        let current = self.inner.states.get(id).is_some_and(|state| {
            state.generation == generation && self.revision(&state.config) == revision
        });
        if !current {
            for waiter in waiters {
                let _ = waiter.send(Ok(()));
            }
            return;
        }
        match result.unwrap_or(Err(DiscoveryFailure::default())) {
            Ok(fingerprint) => {
                let (changed, is_stale) = {
                    let Some(state) = self.inner.states.get_mut(id) else {
                        return;
                    };
                    let changed = state
                        .connection_fingerprint
                        .as_ref()
                        .is_some_and(|known| known != &fingerprint);
                    state.connection_fingerprint = Some(fingerprint);
                    state.probe_retry_at = 0.0;
                    if changed {
                        state.backoff.reset();
                        state.retry_at = 0.0;
                        state.dirty = true;
                    }
                    let is_stale = stale(&self.options, state);
                    (changed, is_stale)
                };
                if changed || is_stale {
                    match self.start_flight(id, RefreshCause::Background) {
                        FlightStart::Started(token) | FlightStart::Running(token) => {
                            self.refresh_ok_waiters
                                .entry(token)
                                .or_default()
                                .extend(waiters);
                        }
                        FlightStart::Skipped => {
                            for waiter in waiters {
                                let _ = waiter.send(Ok(()));
                            }
                        }
                    }
                } else {
                    for waiter in waiters {
                        let _ = waiter.send(Ok(()));
                    }
                }
            }
            Err(failure) => {
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
                self.fail(
                    id,
                    Some(failure),
                    code,
                    &crate::catalog::actor::FailureReport {
                        started_at,
                        diagnostics: &crate::catalog::DiscoveryDiagnostics::default(),
                        revision: None,
                        token: None,
                    },
                );
                if let Some(state) = self.inner.states.get_mut(id) {
                    state.probe_retry_at = state.retry_at;
                }
                self.notify_id(id);
                for waiter in waiters {
                    let _ = waiter.send(Ok(()));
                }
            }
        }
    }

    /// Aborts one probe by token, freeing its signal, timer, waiters and capacity once.
    pub(crate) fn abort_probe(&mut self, id: &str, token: u64) {
        let owns_row = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.probe.as_ref())
            .is_some_and(|probe| probe.token == token);
        if owns_row && let Some(state) = self.inner.states.get_mut(id) {
            state.probe = None;
        }
        if self.probe_rows.remove(&token).is_some() {
            self.inner.probes = self.inner.probes.saturating_sub(1);
        }
        if let Some(cancel) = self.probe_cancels.remove(&token) {
            cancel();
        }
        if let Some(signal) = self.probe_signals.remove(&token) {
            signal.abort();
        }
        self.timed_out_probes.remove(&token);
        for waiter in self.probe_waiters.remove(&token).unwrap_or_default() {
            let _ = waiter.send(Ok(()));
        }
    }

    /// Aborts whatever probe a row currently owns, before the row is replaced or removed.
    pub(crate) fn abort_rows_probe(&mut self, id: &str) {
        if let Some(token) = self
            .inner
            .states
            .get(id)
            .and_then(|state| state.probe.as_ref().map(|probe| probe.token))
        {
            self.abort_probe(id, token);
        }
    }
}

fn with_binary_path(config: &ModelInstance, path: Option<&str>) -> ModelInstance {
    match path {
        Some(path) => ModelInstance {
            executable: path.to_owned(),
            ..config.clone()
        },
        None => config.clone(),
    }
}
