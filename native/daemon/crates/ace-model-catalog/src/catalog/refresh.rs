// SPDX-License-Identifier: Apache-2.0
//! Discovery flights (`catalog.ts` `#refresh`, `revalidate`, `reconcileConnections`).
//!
//! A row discovers at most once at a time: concurrent readers share the flight, a failure
//! waits out its per-source backoff, and an abort (timeout, timeout of the caller, removal)
//! settles the flight without writing. The entry is committed only if the row and its
//! revision are still the ones the flight started under.

use std::sync::Arc;

use ace_protocol::generated::ProviderKind;
use serde_json::Value;

use crate::catalog::{
    Catalog, CatalogError, CatalogOptions, DiscoveryDiagnostics, DiscoveryRequest, ErrorReport,
    Flight, InstanceStatus, StatusError, fresh_status, identity_revision, lock, owns, sha256_json,
};
use crate::failures::{DiscoveryError, DiscoveryFailure, FailureCode, discovery_error};
use crate::gate::{AcpRowFacts, RefreshCause, acp_probe_allowed};
use crate::signals::Signal;
use crate::sources::SourceStatus;

/// Re-checks every stale row, scheduling a flight for the ones whose retry pause is over.
pub(crate) fn revalidate(catalog: &Catalog, ids: &[String], cause: RefreshCause) {
    if catalog.with_inner(|inner| inner.closed) {
        return;
    }
    let due: Vec<String> = catalog.with_inner(|inner| {
        ids.iter()
            .filter(|id| {
                inner
                    .states
                    .get(*id)
                    .is_some_and(|state| catalog.stale(state) && catalog.now() >= state.retry_at)
            })
            .cloned()
            .collect()
    });
    for id in due {
        catalog.spawn_refresh(id, cause);
    }
}

impl Catalog {
    /// Starts a flight in the background and forgets it.
    pub(crate) fn spawn_refresh(&self, id: String, cause: RefreshCause) {
        let catalog = self.clone();
        self.options.spawn.spawn(Box::pin(async move {
            let _ = catalog.refresh_state(&id, cause).await;
        }));
    }

    /// Discovers one row, sharing a flight that is already running.
    pub(crate) async fn refresh_state(&self, id: &str, cause: RefreshCause) -> InstanceStatus {
        match self.start_flight(id, cause) {
            FlightStart::Started(flight) => {
                self.run_flight(id, cause, flight).await;
            }
            FlightStart::Running(flight) => flight.done.wait().await,
            FlightStart::Skipped => {}
        }
        fresh_status(self, id).unwrap_or_else(|| empty_status(self, id))
    }

    /// Explicit refresh: resets the pause and owns the result through settings changes.
    pub(crate) async fn refresh_current(&self, id: &str, cause: RefreshCause) -> InstanceStatus {
        self.with_inner(|inner| {
            if let Some(state) = inner.states.get_mut(id) {
                state.probe_retry_at = 0.0;
                state.backoff.reset();
                state.retry_at = 0.0;
            }
        });
        let mut revision = self
            .registered(id)
            .map(|config| self.revision(&config))
            .unwrap_or_default();
        let mut status = self.refresh_state(id, cause).await;
        loop {
            if self.with_inner(|inner| inner.closed || !inner.states.contains_key(id)) {
                break;
            }
            let Some(config) = self.registered(id) else {
                break;
            };
            let current = self.revision(&config);
            let flying = self.with_inner(|inner| {
                inner
                    .states
                    .get(id)
                    .is_some_and(|state| state.flight.is_some())
            });
            if !flying && current == revision {
                break;
            }
            revision = current;
            status = self.refresh_state(id, cause).await;
        }
        status
    }

    /// Whether `id` still holds the registration this work started under.
    fn owns_generation(&self, id: &str, generation: u64) -> bool {
        self.with_inner(|inner| owns(inner, id, generation))
    }

    /// Installs a flight for `id`, or reports the one already running.
    fn start_flight(&self, id: &str, cause: RefreshCause) -> FlightStart {
        let flight = {
            let mut inner = lock(&self.inner);
            let now = self.now();
            let Some(state) = inner.states.get(id) else {
                return FlightStart::Skipped;
            };
            let generation = state.generation;
            if let Some(flight) = state.flight.clone() {
                return FlightStart::Running(flight);
            }
            if inner.closed {
                return FlightStart::Skipped;
            }
            let facts = AcpRowFacts {
                loaded: state.entry.is_some(),
                loaded_before: inner.acp_loaded.contains(id) || state.entry.is_some(),
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
            if inner.active_flights >= 64 {
                if let Some(state) = inner.states.get_mut(id) {
                    state.error = Some(StatusError::DiscoveryFailed);
                }
                drop(inner);
                // The bound is reported like any other failure; it never retries itself.
                self.fail(
                    id,
                    None,
                    FailureCode::DiscoveryFailed,
                    &FailureReport {
                        started_at: now,
                        diagnostics: &DiscoveryDiagnostics::default(),
                        revision: None,
                        token: None,
                    },
                );
                return FlightStart::Skipped;
            }
            let config = state.config.clone();
            if config.provider == ProviderKind::Acp {
                let admitted = inner.acp_spacing.admit(id, now);
                if !admitted {
                    return FlightStart::Skipped;
                }
                if let Some(state) = inner.states.get_mut(id) {
                    state.acp_due = false;
                }
            }
            let revision = self.revision(&config);
            let abort = Signal::new();
            let token = inner.flight_token + 1;
            inner.flight_token = token;
            inner.active_flights += 1;
            let flight = Flight {
                done: crate::signals::Gate::new(),
                token,
                generation,
            };
            if let Some(state) = inner.states.get_mut(id) {
                state.probe_revision = Some(revision);
                state.abort = Some(abort);
                state.flight = Some(flight.clone());
                state.flight_token = Some(token);
            }
            // A flight is catalog work even when its row is replaced or removed.
            inner.owned.push(flight.done.clone());
            inner
                .row_flights
                .entry(id.to_owned())
                .or_default()
                .push(flight.done.clone());
            flight
        };
        if let Some(config) = self.registered(id) {
            self.notify_config(&config);
        }
        FlightStart::Started(flight)
    }

    /// One flight's body. Every write re-checks that this row and revision are current.
    async fn run_flight(&self, id: &str, _cause: RefreshCause, flight: Flight) {
        let _guard = FlightGuard {
            catalog: self.clone(),
            id: id.to_owned(),
            token: flight.token,
            gate: flight.done.clone(),
        };
        // The registration this flight belongs to may be gone before it takes its slot.
        if !self.owns_generation(id, flight.generation) {
            return;
        }
        // A removal, a new login or a settings change aborts the row: a flight still
        // queued behind another row's discovery leaves the queue instead of holding
        // its remover or invalidator until that other discovery ends.
        let Some(signal) = self.with_inner(|inner| inner.states.get(id)?.abort.clone()) else {
            return;
        };
        let _permit = match futures::future::select(
            Box::pin(self.limiter.acquire()),
            Box::pin(signal.wait()),
        )
        .await
        {
            futures::future::Either::Left((permit, _)) => permit,
            futures::future::Either::Right(((), _acquire)) => return,
        };
        // Or while it waited in the queue.
        if !self.owns_generation(id, flight.generation) {
            return;
        }
        let Some(config) = self.registered(id) else {
            return;
        };
        let revision = self.revision(&config);
        // A replacement refresh waits for the pending invalidation's delete.
        if let Some(invalidating) = self.with_inner(|inner| inner.invalidating.get(id).cloned()) {
            invalidating.done.wait().await;
        }
        let started_at = self.now();
        let diagnostics = Arc::new(std::sync::Mutex::new(DiscoveryDiagnostics::default()));
        let sink: crate::catalog::DiagnosticSink = {
            let diagnostics = diagnostics.clone();
            Arc::new(move |metadata| {
                let mut current = diagnostics
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                merge_diagnostics(&mut current, metadata);
            })
        };
        // A deadline that fired while admission was pending revokes the whole flight; the
        // timer is armed only around the discovery itself.
        let timed_out = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // A failed home/identity guard revokes cached choices and never launches the
        // provider; a CLI below ace's minimum is refused before it is probed.
        let admit =
            self.with_inner(|inner| inner.states.get(id).and_then(|state| state.admit.clone()));
        if let Some(admit) = admit
            && let Err(error) = admit().await
        {
            // An admission result for a superseded registration acts on nothing.
            if !self.owns_generation(id, flight.generation) {
                return;
            }
            let current = self.with_inner(|inner| {
                let Some(state) = inner.states.get_mut(id) else {
                    return false;
                };
                state.entry = None;
                state.view = None;
                state.dirty = true;
                true
            });
            if current {
                let _ = self.with_inner(|inner| inner.deletions.remove(id));
            }
            self.fail(
                id,
                Some(DiscoveryFailure::new(&error)),
                FailureCode::DiscoveryFailed,
                &FailureReport {
                    started_at,
                    diagnostics: &DiscoveryDiagnostics::default(),
                    revision: Some(&revision),
                    token: Some(flight.token),
                },
            );
            return;
        }
        // Admission can outlive a deadline or a revocation; either way nothing launches.
        let fence = FlightFence {
            flight: &flight,
            signal: &signal,
            revision: &revision,
        };
        if !self.flight_current(id, &fence) {
            return;
        }
        if let Some(cli) = crate::cli::provider_cli(&config.provider.to_string())
            && let Err(too_old) =
                crate::cli::require_minimum(cli, config.installation_version.as_deref())
        {
            self.fail(
                id,
                Some(DiscoveryFailure {
                    code: Some(FailureCode::CliTooOld.as_str().to_owned()),
                    too_old: Some(too_old),
                    ..DiscoveryFailure::default()
                }),
                FailureCode::CliTooOld,
                &FailureReport {
                    started_at,
                    diagnostics: &DiscoveryDiagnostics::default(),
                    revision: Some(&revision),
                    token: Some(flight.token),
                },
            );
            return;
        }
        // The deadline covers the discovery alone: an early refusal leaves no timer armed.
        // The deadline covers the discovery and the commit behind it: it stays armed until
        // this flight returns, so a queue held past the deadline still aborts the write.
        let _deadline = Armed(Some(self.options.deadline.arm(self.options.timeout_ms, {
            let flag = timed_out.clone();
            let signal = signal.clone();
            Box::new(move || {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                signal.abort();
            })
        })));
        let inflight = self.options.discover.discover(
            DiscoveryRequest {
                instance: with_binary_path(
                    &config,
                    self.configuration(&config).binary_path.as_deref(),
                ),
            },
            signal.clone(),
            sink,
        );
        let outcome = futures::future::select(inflight, Box::pin(signal.wait())).await;
        let aborted = signal.is_aborted();
        let fired = timed_out.load(std::sync::atomic::Ordering::SeqCst);
        // A discovery that reports success after its abort, or one the deadline caught
        // on the same poll, still writes nothing.
        let result = if aborted {
            None
        } else {
            match outcome {
                futures::future::Either::Left((result, _)) => Some(result),
                futures::future::Either::Right(((), _)) => None,
            }
        };
        let aborted = aborted || signal.is_aborted();
        if aborted && !fired {
            // A removal, login change or settings change revoked the flight, not a timer.
            return;
        }
        let diagnostics = diagnostics
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let failure_report = FailureReport {
            started_at,
            diagnostics: &diagnostics,
            revision: Some(&revision),
            token: Some(flight.token),
        };
        match result {
            None => {
                self.fail(
                    id,
                    None,
                    if fired {
                        FailureCode::Timeout
                    } else {
                        FailureCode::DiscoveryFailed
                    },
                    &failure_report,
                );
            }
            Some(Err(failure)) => {
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
                self.fail(id, Some(failure), code, &failure_report);
            }
            Some(Ok(outcome)) => {
                self.commit(id, outcome, started_at, &diagnostics, &fence, &timed_out)
                    .await;
            }
        }
    }

    /// Whether a flight may still write: it owns its row and token, was not aborted, and
    /// the row's effective revision is still the one it started under.
    fn flight_current(&self, id: &str, fence: &FlightFence<'_>) -> bool {
        let FlightFence {
            flight,
            signal,
            revision,
        } = *fence;
        if signal.is_aborted() {
            return false;
        }
        let config = self.with_inner(|inner| {
            if inner.closed {
                return None;
            }
            let state = inner.states.get(id)?;
            if state.generation != flight.generation || state.flight_token != Some(flight.token) {
                return None;
            }
            Some(state.config.clone())
        });
        let Some(config) = config else {
            return false;
        };
        self.revision(&config) == revision
    }

    /// A failed flight: the error the client sees, the pause, and the local log lines.
    fn fail(
        &self,
        id: &str,
        failure: Option<DiscoveryFailure>,
        fallback: FailureCode,
        facts: &FailureReport<'_>,
    ) {
        let FailureReport {
            started_at,
            diagnostics,
            revision,
            token,
        } = *facts;
        let Some((config, sources)) = self.with_inner(|inner| {
            let state = inner.states.get(id)?;
            let sources = state
                .entry
                .as_ref()
                .and_then(|entry| entry.sources.as_ref())
                .map(|sources| sources.iter().map(|status| status.source.clone()).collect());
            Some((state.config.clone(), sources))
        }) else {
            return;
        };
        let sources: Option<Vec<ace_protocol::generated::ModelSource>> =
            if config.provider == ProviderKind::Opencode {
                None
            } else {
                sources.or_else(|| diagnostics.sources.clone())
            };
        let placeholder = DiscoveryFailure::default();
        let named = failure
            .as_ref()
            .or(if diagnostics.source_failures.is_empty() {
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
        let mutated = self.with_inner(|inner| {
            let Some(state) = inner.states.get_mut(id) else {
                return false;
            };
            if let Some(revision) = revision
                && state.probe_revision.as_deref() != Some(revision)
            {
                return false;
            }
            if let Some(token) = token
                && state.flight_token != Some(token)
            {
                return false;
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
                    inner.acp_loaded.insert(id.to_owned());
                }
                if first {
                    report(
                        &self.options,
                        &config,
                        &detail,
                        ReportLine {
                            source: None,
                            source_label: None,
                            duration_ms: now - started_at,
                            schedule: None,
                        },
                        diagnostics,
                    );
                }
                return true;
            }
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
                            (self.options.random)(),
                        )
                        .ok()
                        .map(|schedule| {
                            (
                                if schedule.warn { "warn" } else { "debug" },
                                schedule.retry_in_ms,
                            )
                        })
                });
                report(
                    &self.options,
                    &config,
                    &detail,
                    ReportLine {
                        source: source.as_ref().map(|source| source.id.0.clone()),
                        source_label: source.as_ref().map(|source| source.label.0.clone()),
                        duration_ms: now - started_at,
                        schedule: schedule_now,
                    },
                    diagnostics,
                );
            }
            if schedule.is_none() {
                state.retry_at = state.backoff.retry_at();
            }
            state.error = Some(match fallback {
                FailureCode::Timeout => StatusError::Timeout,
                FailureCode::PersistenceFailed => StatusError::PersistenceFailed,
                _ => StatusError::DiscoveryFailed,
            });
            true
        });
        if mutated && let Some(config) = self.registered(id) {
            self.notify_config(&config);
        }
    }

    /// A successful discovery's commit: merged sources, entry, stored, then published.
    ///
    /// Every wait and both write boundaries re-check the flight, so work whose deadline
    /// passed, or whose row a revocation took, never reaches the cache or the picker.
    async fn commit(
        &self,
        id: &str,
        outcome: crate::catalog::DiscoveryOutcome,
        started_at: f64,
        diagnostics: &DiscoveryDiagnostics,
        fence: &FlightFence<'_>,
        timed_out: &std::sync::atomic::AtomicBool,
    ) {
        let FlightFence {
            flight, revision, ..
        } = *fence;
        let Some(config) = self.registered(id) else {
            return;
        };
        let failure_report = FailureReport {
            started_at,
            diagnostics,
            revision: Some(revision),
            token: Some(flight.token),
        };
        if outcome.models.is_empty() && outcome.sources.is_none() {
            self.fail(
                id,
                Some(DiscoveryFailure::new("The CLI returned no model choices")),
                FailureCode::DiscoveryFailed,
                &failure_report,
            );
            return;
        }
        if !self.flight_current(id, fence) {
            self.fenced_out(
                id,
                started_at,
                diagnostics,
                fence,
                timed_out.load(std::sync::atomic::Ordering::SeqCst),
            );
            return;
        }
        let release = self.hold_turn(id).await;
        // The row must still be this flight's after the wait: a revocation accepted while
        // the queue was held has already re-registered it.
        if !self.flight_current(id, fence) {
            self.fenced_out(
                id,
                started_at,
                diagnostics,
                fence,
                timed_out.load(std::sync::atomic::Ordering::SeqCst),
            );
            return;
        }
        let previous = self.with_inner(|inner| {
            inner
                .states
                .get(id)
                .and_then(|state| state.entry.as_ref())
                .map(|entry| Arc::new((**entry).clone()))
        });
        if self.finish_deletion(id).is_err() {
            self.commit_failed(id, started_at, diagnostics, fence);
            drop(release);
            return;
        }
        if !self.flight_current(id, fence) {
            self.fenced_out(
                id,
                started_at,
                diagnostics,
                fence,
                timed_out.load(std::sync::atomic::Ordering::SeqCst),
            );
            drop(release);
            return;
        }
        let now = self.now();
        let combined = crate::sources::refreshed_sources(
            crate::cleanup::clean_catalog(&outcome.models)
                .into_iter()
                .map(Arc::new)
                .collect(),
            outcome.sources.as_deref(),
            previous.as_deref(),
            now,
        );
        let permission_modes = outcome.permission_modes.clone().or_else(|| {
            self.with_inner(|inner| {
                inner.states.get(id).and_then(|state| {
                    state.permission_modes.clone().or_else(|| {
                        state
                            .entry
                            .as_ref()
                            .and_then(|entry| entry.permission_modes.clone())
                    })
                })
            })
        });
        let entry = crate::cache::CacheEntry {
            provider: config.provider,
            instance: config.id.clone(),
            login_revision: Some(config.login_revision.clone()),
            revision: revision.to_owned(),
            refreshed_at: now,
            models: combined.models,
            sources: Some(combined.sources),
            permission_modes,
            identity_revision: Some(identity_revision(&config)),
            connection_revision: Some(connection_revision(
                config.provider,
                &outcome.models,
                outcome.sources.as_deref(),
            )),
        };
        // A row the protocol refuses, or one of another instance, is a persistence
        // failure, never a published row.
        let row_error = entry
            .models
            .iter()
            .any(|row| ace_models::row::validate_row(row).is_err())
            || crate::cache::validate_entry(&entry).is_err();
        if row_error {
            self.commit_failed(id, started_at, diagnostics, fence);
            drop(release);
            return;
        }
        // The persist boundary: nothing is stored for a flight that lost its place.
        if !self.flight_current(id, fence) {
            self.fenced_out(
                id,
                started_at,
                diagnostics,
                fence,
                timed_out.load(std::sync::atomic::Ordering::SeqCst),
            );
            drop(release);
            return;
        }
        let mut storage = self.storage.clone();
        let stored = storage.replace(&entry);
        if stored.is_err() {
            self.commit_failed(id, started_at, diagnostics, fence);
            drop(release);
            return;
        }
        // The publish boundary: a row stored for a flight that lost its place while it was
        // written is never served, exactly as the TypeScript's queue leaves it.
        if !self.flight_current(id, fence) {
            self.fenced_out(
                id,
                started_at,
                diagnostics,
                fence,
                timed_out.load(std::sync::atomic::Ordering::SeqCst),
            );
            drop(release);
            return;
        }
        let entry = Arc::new(entry);
        let failing: Vec<String> = entry
            .sources
            .as_ref()
            .map(|sources| {
                sources
                    .iter()
                    .filter(|status| crate::sources::source_failed(status))
                    .map(|status| status.source.id.0.clone())
                    .collect()
            })
            .unwrap_or_default();
        let mut no_models = std::collections::BTreeSet::new();
        let mut new_no_models: Vec<SourceStatus> = Vec::new();
        if let Some(sources) = &entry.sources {
            for source in sources {
                if let Some(error) = &source.error
                    && matches!(
                        error.code,
                        FailureCode::NoModels | FailureCode::NotConfigured
                    )
                {
                    no_models.insert(source.source.id.0.clone());
                    new_no_models.push(source.clone());
                }
            }
        }
        let previous_no_models = self.with_inner(|inner| {
            inner
                .states
                .get(id)
                .and_then(|state| state.no_model_sources.clone())
        });
        let changed = self.with_inner(|inner| {
            let Some(state) = inner.states.get_mut(id) else {
                return false;
            };
            if state.generation != flight.generation || state.flight_token != Some(flight.token) {
                return false;
            }
            state.entry = Some(entry.clone());
            state.dirty = false;
            state.error = None;
            state.error_detail = None;
            state.unconfigured_at = None;
            state.view = None;
            state.no_model_sources = Some(no_models.clone());
            state.backoff.retain(failing);
            state.connection_fingerprint = entry.connection_revision.clone();
            state.retry_at = state.backoff.retry_at();
            true
        });
        if !changed {
            drop(release);
            return;
        }
        drop(release);
        for source in new_no_models {
            let seen = previous_no_models
                .as_ref()
                .is_some_and(|seen| seen.contains(&source.source.id.0));
            if seen {
                continue;
            }
            let detail = source.error.clone().unwrap_or_else(|| {
                discovery_error(
                    None,
                    FailureCode::NoModels,
                    &crate::failures::ErrorContext::default(),
                )
            });
            report(
                &self.options,
                &config,
                &detail,
                ReportLine {
                    source: Some(source.source.id.0.clone()),
                    source_label: Some(source.source.label.0.clone()),
                    duration_ms: self.now() - started_at,
                    schedule: Some(("info", self.options.ttl_ms)),
                },
                diagnostics,
            );
        }
        // A failing source that kept its rows is still reported, once per commit.
        if let Some(sources) = &entry.sources {
            for source in sources {
                if let Some(error) = &source.error
                    && crate::sources::source_failed(source)
                {
                    report(
                        &self.options,
                        &config,
                        error,
                        ReportLine {
                            source: Some(source.source.id.0.clone()),
                            source_label: Some(source.source.label.0.clone()),
                            duration_ms: self.now() - started_at,
                            schedule: None,
                        },
                        diagnostics,
                    );
                }
            }
        }
        self.notify_config(&config);
    }

    /// A flight that lost its place before it could write: the deadline says so, a
    /// revocation does not.
    fn fenced_out(
        &self,
        id: &str,
        started_at: f64,
        diagnostics: &DiscoveryDiagnostics,
        fence: &FlightFence<'_>,
        fired: bool,
    ) {
        if !fired {
            return;
        }
        self.fail(
            id,
            None,
            FailureCode::Timeout,
            &FailureReport {
                started_at,
                diagnostics,
                revision: Some(fence.revision),
                token: Some(fence.flight.token),
            },
        );
    }

    fn commit_failed(
        &self,
        id: &str,
        started_at: f64,
        diagnostics: &DiscoveryDiagnostics,
        fence: &FlightFence<'_>,
    ) {
        let FlightFence {
            flight, revision, ..
        } = *fence;
        let Some(config) = self.registered(id) else {
            return;
        };
        if !self.flight_current(id, fence) {
            return;
        }
        let mutated = self.with_inner(|inner| {
            let Some(state) = inner.states.get_mut(id) else {
                return false;
            };
            if state.generation != flight.generation || state.flight_token != Some(flight.token) {
                return false;
            }
            state.dirty = true;
            state.error = Some(StatusError::PersistenceFailed);
            true
        });
        if mutated {
            self.fail(
                id,
                None,
                FailureCode::PersistenceFailed,
                &FailureReport {
                    started_at,
                    diagnostics,
                    revision: Some(revision),
                    token: Some(flight.token),
                },
            );
            self.notify_config(&config);
        }
    }
}

/// An armed deadline that stays armed for as long as its flight owns it, and is cancelled
/// when the flight ends, whichever way it ends.
struct Armed(Option<crate::catalog::Cancel>);

impl Drop for Armed {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel();
        }
    }
}

/// What one flight still has to be for its result to count: its own token and generation,
/// no abort, and the effective revision it started under.
struct FlightFence<'a> {
    flight: &'a Flight,
    signal: &'a Signal,
    revision: &'a str,
}

/// One flight's local report of a failure: when it started, what its port learned, the
/// revision it ran under and the token that still has to own the row.
struct FailureReport<'a> {
    started_at: f64,
    diagnostics: &'a DiscoveryDiagnostics,
    /// The revision the flight ran under; a connection probe already fenced its own row.
    revision: Option<&'a str>,
    token: Option<u64>,
}

enum FlightStart {
    Started(Flight),
    Running(Flight),
    Skipped,
}

struct FlightGuard {
    catalog: Catalog,
    id: String,
    token: u64,
    gate: crate::signals::Gate,
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        self.catalog.with_inner(|inner| {
            inner.active_flights = inner.active_flights.saturating_sub(1);
            if let Some(state) = inner.states.get_mut(&self.id)
                && state.flight_token == Some(self.token)
            {
                state.flight.take();
                if let Some(abort) = state.abort.take() {
                    abort.abort();
                }
                state.probe_revision = None;
                state.flight_token = None;
            }
            inner.owned.retain(|known| !known.same(&self.gate));
            if let Some(flights) = inner.row_flights.get_mut(&self.id) {
                flights.retain(|known| !known.same(&self.gate));
                if flights.is_empty() {
                    inner.row_flights.remove(&self.id);
                }
            }
            // The gate belongs to this flight, not to whichever state replaced it:
            // an invalidate or remove waiting on it must never hang.
            self.gate.open();
        });
        if let Some(config) = self.catalog.registered(&self.id) {
            self.catalog.notify_config(&config);
        }
    }
}

fn empty_status(_catalog: &Catalog, id: &str) -> InstanceStatus {
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

fn with_binary_path(
    config: &ace_models::instance::ModelInstance,
    path: Option<&str>,
) -> ace_models::instance::ModelInstance {
    match path {
        Some(path) => ace_models::instance::ModelInstance {
            executable: path.to_owned(),
            ..config.clone()
        },
        None => config.clone(),
    }
}

fn merge_diagnostics(current: &mut DiscoveryDiagnostics, metadata: DiscoveryDiagnostics) {
    if metadata.cli_version.is_some() {
        current.cli_version = metadata.cli_version;
    }
    if metadata.stage.is_some() {
        current.stage = metadata.stage;
    }
    if metadata.sources.is_some() {
        current.sources = metadata.sources;
    }
    current.rejected_models.extend(metadata.rejected_models);
    current.source_failures.extend(metadata.source_failures);
}

/// One per-source line's own facts, beside the fixed error text.
struct ReportLine<'a> {
    source: Option<String>,
    source_label: Option<String>,
    duration_ms: f64,
    schedule: Option<(&'a str, f64)>,
}

/// The fixed text a per-source failure re-reported keeps.
fn report(
    options: &CatalogOptions,
    config: &ace_models::instance::ModelInstance,
    detail: &DiscoveryError,
    line: ReportLine<'_>,
    diagnostics: &DiscoveryDiagnostics,
) {
    let Some(on_error) = &options.on_error else {
        return;
    };
    on_error(ErrorReport {
        provider: config.provider,
        instance: config.id.clone(),
        error: detail.clone(),
        source: line.source,
        source_label: line.source_label,
        duration_ms: line.duration_ms.max(0.0),
        cli_version: diagnostics.cli_version.clone(),
        stage: diagnostics.stage.clone(),
        level: line.schedule.map(|(level, _)| level.to_owned()),
        retry_in_ms: line.schedule.map(|(_, retry_in)| retry_in),
        reason: None,
        model_index: None,
    });
}

/// `connectionRevision`: only non-secret provider identities and availability are hashed.
fn connection_revision(
    provider: ProviderKind,
    models: &[ace_protocol::generated::CatalogModel],
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

/// One registered connection probe. Dropping it cancels its deadline, settles its gate
/// and removes its registry entries, whichever way its caller leaves.
struct ProbeGuard {
    catalog: Catalog,
    id: String,
    signal: Signal,
    gate: crate::signals::Gate,
    cancel: Option<crate::catalog::Cancel>,
}

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
        self.signal.abort();
        self.catalog.with_inner(|inner| {
            inner.owned.retain(|known| !known.same(&self.gate));
            if let Some(flights) = inner.row_flights.get_mut(&self.id) {
                flights.retain(|known| !known.same(&self.gate));
                if flights.is_empty() {
                    inner.row_flights.remove(&self.id);
                }
            }
            inner
                .probe_signals
                .retain(|known| !known.same(&self.signal));
            inner.probes = inner.probes.saturating_sub(1);
            if let Some(state) = inner.states.get_mut(&self.id)
                && state
                    .probe
                    .as_ref()
                    .is_some_and(|probe| probe.done.same(&self.gate))
            {
                state.probe = None;
            }
        });
        self.gate.open();
    }
}

/// Re-checks CLI-owned connections at most every `connectionCheckMs`.
impl Catalog {
    pub(crate) fn check_connections(&self) {
        let Some(interval) = self.options.connection_check_ms else {
            return;
        };
        if self.with_inner(|inner| inner.closed) {
            return;
        }
        let now = self.now();
        let due = self.with_inner(|inner| {
            inner
                .connections_checked_at
                .is_none_or(|last| now - last >= interval)
        });
        if !due {
            return;
        }
        self.with_inner(|inner| inner.connections_checked_at = Some(now));
        self.spawn_reconcile();
    }

    fn spawn_reconcile(&self) {
        let catalog = self.clone();
        self.options.spawn.spawn(Box::pin(async move {
            let _ = catalog.reconcile_connections().await;
        }));
    }

    /// Poll only CLI connection metadata; unchanged metadata never starts discovery.
    pub async fn reconcile_connections(&self) -> Result<(), CatalogError> {
        let Some(probe) = self.options.revision_probe.clone() else {
            return Ok(());
        };
        let ids: Vec<String> = self.with_inner(|inner| {
            inner
                .order
                .iter()
                .filter(|id| {
                    inner.states.get(*id).is_some_and(|state| {
                        matches!(
                            state.config.provider,
                            ProviderKind::Opencode | ProviderKind::Pi
                        ) && self.enabled(&state.config)
                    })
                })
                .cloned()
                .collect()
        });
        for id in ids {
            let Some(config) = self.registered(&id) else {
                continue;
            };
            let generation =
                self.with_inner(|inner| inner.states.get(&id).map(|state| state.generation));
            let revision = self.revision(&config);
            // Registering the probe and checking that shutdown has not begun are one
            // critical section: no probe starts after close aborted the registry. A poll
            // that finds this row's probe running shares it.
            let registered = self.with_inner(|inner| {
                if inner.closed {
                    return None;
                }
                if let Some(running) = inner.states.get(&id).and_then(|state| state.probe.clone()) {
                    return Some(Err(running.done));
                }
                if inner.probes >= 64 {
                    return None;
                }
                let now = self.now();
                let state = inner.states.get_mut(&id)?;
                if state.flight.is_some() || now < state.probe_retry_at.max(state.retry_at) {
                    return None;
                }
                let signal = Signal::new();
                let gate = crate::signals::Gate::new();
                state.probe = Some(crate::catalog::ProbeFlight { done: gate.clone() });
                inner.probe_signals.push(signal.clone());
                inner.owned.push(gate.clone());
                inner.probes += 1;
                Some(Ok((signal, gate)))
            });
            let (signal, gate) = match registered {
                Some(Ok(registered)) => registered,
                Some(Err(done)) => {
                    done.wait().await;
                    continue;
                }
                None => continue,
            };
            // The probe owns a deadline, a shutdown abort and a registry entry: whatever
            // ends its caller, its gate settles and its entry leaves the registry.
            let mut guard = ProbeGuard {
                catalog: self.clone(),
                id: id.clone(),
                signal: signal.clone(),
                gate,
                cancel: None,
            };
            let timed_out = Arc::new(std::sync::atomic::AtomicBool::new(false));
            guard.cancel = Some(self.options.deadline.arm(
                self.options.timeout_ms,
                Box::new({
                    let flag = timed_out.clone();
                    let signal = signal.clone();
                    move || {
                        flag.store(true, std::sync::atomic::Ordering::SeqCst);
                        signal.abort();
                    }
                }),
            ));
            let request = DiscoveryRequest {
                instance: with_binary_path(
                    &config,
                    self.configuration(&config).binary_path.as_deref(),
                ),
            };
            let outcome = futures::future::select(
                Box::pin(probe.probe(request, signal.clone())),
                Box::pin(signal.wait()),
            )
            .await;
            if let Some(cancel) = guard.cancel.take() {
                cancel();
            }
            let aborted = signal.is_aborted();
            let fired = timed_out.load(std::sync::atomic::Ordering::SeqCst);
            drop(guard);
            if aborted && !fired {
                // Shutdown or a revocation, not a timer: nothing to report.
                continue;
            }
            let result = match outcome {
                futures::future::Either::Left((result, _)) => Some(result),
                futures::future::Either::Right(((), _)) => None,
            };
            let started_at = self.now();
            // The login, the flight's generation and the effective revision are read from
            // the state already under the lock; asking `registered` (or `revision`) here
            // would take the same mutex again and wedge the catalog.
            let config = self.with_inner(|inner| {
                if inner.closed || !owns(inner, &id, generation.unwrap_or(u64::MAX)) {
                    return None;
                }
                inner.states.get(&id).map(|state| state.config.clone())
            });
            let Some(config) = config else {
                continue;
            };
            if self.revision(&config) != revision {
                continue;
            }
            let Some(result) = result else {
                // A fired deadline leaves a visible timeout and its own retry pause.
                self.fail(
                    id.as_str(),
                    None,
                    FailureCode::Timeout,
                    &FailureReport {
                        started_at,
                        diagnostics: &DiscoveryDiagnostics::default(),
                        revision: None,
                        token: None,
                    },
                );
                self.with_inner(|inner| {
                    if let Some(state) = inner.states.get_mut(&id) {
                        state.probe_retry_at = state.retry_at;
                    }
                });
                if let Some(config) = self.registered(&id) {
                    self.notify_config(&config);
                }
                continue;
            };
            match result {
                Ok(fingerprint) => {
                    let changed = self.with_inner(|inner| {
                        let Some(state) = inner.states.get_mut(&id) else {
                            return false;
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
                        changed
                    });
                    let stale = self.with_inner(|inner| {
                        inner.states.get(&id).is_some_and(|state| self.stale(state))
                    });
                    if changed || stale {
                        let _ = self.refresh_state(&id, RefreshCause::Background).await;
                    }
                }
                Err(failure) => {
                    // An ordinary probe failure schedules its own backoff, never a tight loop.
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
                        id.as_str(),
                        Some(failure),
                        code,
                        &FailureReport {
                            started_at,
                            diagnostics: &DiscoveryDiagnostics::default(),
                            revision: None,
                            token: None,
                        },
                    );
                    self.with_inner(|inner| {
                        if let Some(state) = inner.states.get_mut(&id) {
                            state.probe_retry_at = state.retry_at;
                        }
                    });
                    if let Some(config) = self.registered(&id) {
                        self.notify_config(&config);
                    }
                }
            }
        }
        Ok(())
    }

    /// While a client watches the catalog, re-check connections every interval.
    pub fn observe_connections(&self) -> CancelHandle {
        if self.options.connection_check_ms.is_none() || self.with_inner(|inner| inner.closed) {
            return CancelHandle { _handle: None };
        }
        self.with_inner(|inner| inner.observers += 1);
        CancelHandle {
            _handle: Some(ObservedHandle {
                catalog: self.clone(),
            }),
        }
    }
}

/// Stops observing the catalog.
pub struct CancelHandle {
    /// Dropping the handle decrements the observer count.
    _handle: Option<ObservedHandle>,
}

pub struct ObservedHandle {
    catalog: Catalog,
}

impl Drop for ObservedHandle {
    fn drop(&mut self) {
        let cancel = self.catalog.with_inner(|inner| {
            inner.observers = inner.observers.saturating_sub(1);
            if inner.observers == 0 {
                inner.observed_check.take()
            } else {
                None
            }
        });
        if let Some(cancel) = cancel {
            cancel();
        }
    }
}
