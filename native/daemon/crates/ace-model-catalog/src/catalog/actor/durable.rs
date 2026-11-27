// SPDX-License-Identifier: Apache-2.0
//! The actor's durable half: storage jobs, their continuations, and close.
//!
//! Everything here either dispatches work to the storage lane or resumes from its
//! reply. The actor never touches storage itself; a turn place stays open until the
//! lane answers, and the token a job carries is rechecked on both sides of the write.

use std::collections::BTreeSet;
use std::sync::Arc;

use ace_models::instance::ModelInstance;

use crate::catalog::actor::{Actor, FailureReport, report_line};
use crate::catalog::flights::Commit;
use crate::catalog::storage_lane::{Cancel, Job, Outcome};
use crate::catalog::{CatalogError, DiscoveryDiagnostics, FailureCode};
use crate::failures::discovery_error;

/// What one admitted storage job will do when its reply arrives.
pub(crate) enum StorageWait {
    CommitDelete(Box<CommitPlan>),
    CommitReplace(Box<CommitPlan>),
    SessionDelete(Box<SessionWritePlan>),
    SessionReplace(Box<SessionWritePlan>),
    PermissionReplace(Box<crate::catalog::writes::PermissionWrite>),
    Invalidation { id: String, token: u64, place: u64 },
    Removal { id: String, token: u64 },
    Deletion { id: String },
    Close,
}

/// One discovery commit, computed before its durable write and resumed after it.
pub(crate) struct CommitPlan {
    pub(crate) place: u64,
    pub(crate) id: String,
    pub(crate) token: u64,
    pub(crate) generation: u64,
    pub(crate) revision: String,
    pub(crate) started_at: f64,
    pub(crate) diagnostics: DiscoveryDiagnostics,
    pub(crate) entry: crate::cache::CacheEntry,
    pub(crate) config: ModelInstance,
    pub(crate) previous_no_models: Option<BTreeSet<String>>,
}

/// One session write, computed before its durable write and resumed after it.
pub(crate) struct SessionWritePlan {
    pub(crate) place: u64,
    pub(crate) entry: crate::cache::CacheEntry,
    pub(crate) write: crate::catalog::writes::SessionWrite,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseStage {
    Idle,
    Closing,
}

impl Actor {
    pub(crate) fn settle_place(&mut self, id: &str, place: u64) {
        if let Some(entry) = self.inner.turns.get_mut(id) {
            entry.settle(place);
        }
        self.pump(id);
    }

    pub(crate) fn dispatch_storage(&mut self, wait: StorageWait, job: Job) {
        self.next_storage += 1;
        let key = self.next_storage;
        self.storage_waits.insert(key, wait);
        self.pending_storage += 1;
        self.lane.dispatch(key, job);
    }

    pub(crate) fn storage_done(&mut self, key: u64, outcome: Outcome) {
        self.pending_storage = self.pending_storage.saturating_sub(1);
        let Some(wait) = self.storage_waits.remove(&key) else {
            self.after_event();
            return;
        };
        match wait {
            StorageWait::CommitDelete(plan) => self.commit_deleted(*plan, outcome),
            StorageWait::CommitReplace(plan) => self.commit_replaced(*plan, outcome),
            StorageWait::SessionDelete(plan) => self.session_deleted(*plan, outcome),
            StorageWait::SessionReplace(plan) => self.session_replaced(*plan, outcome),
            StorageWait::PermissionReplace(write) => self.permission_replaced(*write, outcome),
            StorageWait::Invalidation { id, token, place } => {
                self.invalidation_removed(&id, token, place, outcome)
            }
            StorageWait::Removal { id, token } => self.removal_done(&id, token, outcome),
            StorageWait::Deletion { id } => self.deletion_done(&id, outcome),
            StorageWait::Close => self.close_stored(outcome),
        }
        self.release_quiesce_waiters();
        self.after_event();
    }

    /// Adds one row's marker before its removal is dispatched, and starts the removal.
    pub(crate) fn begin_delete(&mut self, id: &str) {
        if !self.inner.deletions.reserve(id) {
            return;
        }
        self.dispatch_storage(
            StorageWait::Deletion { id: id.to_owned() },
            Job::Remove {
                instance: id.to_owned(),
            },
        );
    }

    pub(crate) fn deletion_done(&mut self, id: &str, outcome: Outcome) {
        if matches!(outcome, Outcome::Done) {
            self.inner.deletions.forget(id);
        }
    }

    pub(crate) fn begin_commit(&mut self, commit: Box<Commit>, place: u64) -> bool {
        let Commit {
            id,
            token,
            generation,
            revision,
            started_at,
            diagnostics,
            outcome,
        } = *commit;
        self.pending_commits = self.pending_commits.saturating_sub(1);
        let report = FailureReport {
            started_at,
            diagnostics: &diagnostics,
            revision: Some(&revision),
            token: Some(token),
        };
        let fired = self.timed_out_flights.contains(&token);
        if !self.flight_current(&id, token, generation, &revision) {
            if fired {
                self.fail(&id, None, FailureCode::Timeout, &report);
            }
            self.commit_tokens.remove(&token);
            self.settle_flight(&id, token);
            return true;
        }
        let Some(config) = self.inner.states.get(&id).map(|state| state.config.clone()) else {
            self.commit_tokens.remove(&token);
            self.settle_flight(&id, token);
            return true;
        };
        let previous = self
            .inner
            .states
            .get(&id)
            .and_then(|state| state.entry.as_ref())
            .map(|entry| Arc::new((**entry).clone()));
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
            self.inner.states.get(&id).and_then(|state| {
                state.permission_modes.clone().or_else(|| {
                    state
                        .entry
                        .as_ref()
                        .and_then(|entry| entry.permission_modes.clone())
                })
            })
        });
        let entry = crate::cache::CacheEntry {
            provider: config.provider,
            instance: config.id.clone(),
            login_revision: Some(config.login_revision.clone()),
            revision: revision.clone(),
            refreshed_at: now,
            models: combined.models,
            sources: Some(combined.sources),
            permission_modes,
            identity_revision: Some(crate::catalog::identity_revision(&config)),
            connection_revision: Some(crate::catalog::flights_connection_revision(
                config.provider,
                &outcome.models,
                outcome.sources.as_deref(),
            )),
        };
        let row_error = entry
            .models
            .iter()
            .any(|row| ace_models::row::validate_row(row).is_err())
            || crate::cache::validate_entry(&entry).is_err();
        if row_error {
            self.commit_tokens.remove(&token);
            self.commit_failed(&id, &report, generation);
            self.settle_flight(&id, token);
            return true;
        }
        let previous_no_models = self
            .inner
            .states
            .get(&id)
            .and_then(|state| state.no_model_sources.clone());
        let plan = CommitPlan {
            place,
            id: id.clone(),
            token,
            generation,
            revision,
            started_at,
            diagnostics,
            entry,
            config,
            previous_no_models,
        };
        if self.inner.deletions.has(&id) {
            self.dispatch_storage(
                StorageWait::CommitDelete(Box::new(plan)),
                Job::Remove { instance: id },
            );
        } else {
            self.dispatch_commit_replace(plan);
        }
        false
    }

    /// Starts the durable write, with the token that may cancel it before it lands.
    pub(crate) fn dispatch_commit_replace(&mut self, plan: CommitPlan) {
        let cancel = Cancel::new();
        self.commit_cancels.insert(plan.token, cancel.clone());
        let entry = plan.entry.clone();
        self.dispatch_storage(
            StorageWait::CommitReplace(Box::new(plan)),
            Job::Replace { entry, cancel },
        );
    }

    pub(crate) fn commit_deleted(&mut self, plan: CommitPlan, outcome: Outcome) {
        if !matches!(outcome, Outcome::Done) {
            let report = Self::plan_report_owned(&plan);
            self.commit_cancelled(&plan, &report);
            return;
        }
        self.inner.deletions.forget(&plan.id);
        self.dispatch_commit_replace(plan);
    }

    pub(crate) fn commit_replaced(&mut self, plan: CommitPlan, outcome: Outcome) {
        self.commit_cancels.remove(&plan.token);
        let report = Self::plan_report_owned(&plan);
        if !matches!(outcome, Outcome::Done) {
            self.commit_cancelled(&plan, &report);
            return;
        }
        // The write landed, but the row may have moved on while the lane ran. Its
        // replacement or revocation deletes the row behind this place, so nothing is
        // installed over state that no longer owns it.
        if !self.flight_current(&plan.id, plan.token, plan.generation, &plan.revision) {
            self.commit_tokens.remove(&plan.token);
            if self.timed_out_flights.contains(&plan.token) {
                self.fail(&plan.id, None, FailureCode::Timeout, &report);
            }
            self.settle_flight(&plan.id, plan.token);
            self.settle_place(&plan.id, plan.place);
            return;
        }
        let CommitPlan {
            place,
            id,
            token,
            generation: _,
            revision: _,
            started_at,
            diagnostics,
            entry,
            config,
            previous_no_models,
        } = plan;
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
        let mut no_models = BTreeSet::new();
        let mut new_no_models = Vec::new();
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
        let changed = self.with_state(&id, |state| {
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
        });
        if !changed {
            self.commit_tokens.remove(&token);
            self.settle_flight(&id, token);
            self.settle_place(&id, place);
            return;
        }
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
            report_line(
                &self.options,
                &config,
                &detail,
                Some(source.source.id.0.clone()),
                Some(source.source.label.0.clone()),
                self.now() - started_at,
                Some(("info", self.options.ttl_ms)),
                &diagnostics,
            );
        }
        if let Some(sources) = &entry.sources {
            for source in sources {
                if let Some(error) = &source.error
                    && crate::sources::source_failed(source)
                {
                    report_line(
                        &self.options,
                        &config,
                        error,
                        Some(source.source.id.0.clone()),
                        Some(source.source.label.0.clone()),
                        self.now() - started_at,
                        None,
                        &diagnostics,
                    );
                }
            }
        }
        self.commit_tokens.remove(&token);
        self.settle_flight(&id, token);
        self.settle_place(&id, place);
    }

    pub(crate) fn commit_cancelled(&mut self, plan: &CommitPlan, report: &FailureReport<'_>) {
        self.commit_tokens.remove(&plan.token);
        if self.timed_out_flights.contains(&plan.token) {
            self.fail(&plan.id, None, FailureCode::Timeout, report);
        } else {
            self.commit_failed(&plan.id, report, plan.generation);
        }
        self.settle_flight(&plan.id, plan.token);
        self.settle_place(&plan.id, plan.place);
    }

    /// The failure report one planned commit carries through storage.
    pub(crate) fn plan_report_owned<'a>(plan: &'a CommitPlan) -> FailureReport<'a> {
        FailureReport {
            started_at: plan.started_at,
            diagnostics: &plan.diagnostics,
            revision: Some(&plan.revision),
            token: Some(plan.token),
        }
    }

    pub(crate) fn commit_failed(&mut self, id: &str, report: &FailureReport<'_>, generation: u64) {
        let mutated = self.inner.states.get_mut(id).is_some_and(|state| {
            if state.generation != generation {
                return false;
            }
            state.dirty = true;
            state.error = Some(crate::catalog::StatusError::PersistenceFailed);
            true
        });
        if mutated {
            self.fail(
                id,
                None,
                FailureCode::PersistenceFailed,
                &FailureReport {
                    started_at: report.started_at,
                    diagnostics: report.diagnostics,
                    revision: report.revision,
                    token: report.token,
                },
            );
        }
    }

    pub(crate) fn finish_close_if_ready(&mut self) {
        if !self.closing || self.close_stage != CloseStage::Idle {
            return;
        }
        if !self.in_flight.is_empty()
            || self.inner.session_writes > 0
            || self.inner.invalidations > 0
            || !self.inner.removals.is_empty()
            || self.pending_commits > 0
            || self.pending_storage > 0
        {
            return;
        }
        // Shutdown runs on the storage lane too: the actor never touches the disk.
        self.close_stage = CloseStage::Closing;
        let removals = self.inner.deletions.pending_ids();
        self.dispatch_storage(StorageWait::Close, Job::Close { removals });
    }

    pub(crate) fn close_stored(&mut self, outcome: Outcome) {
        let result = match outcome {
            Outcome::Done => {
                self.inner.deletions.clear();
                Ok(())
            }
            // Every removal stuck but storage itself refused to close: the rows are gone.
            Outcome::Failed(error) => {
                self.inner.deletions.clear();
                Err(CatalogError::Cache(error))
            }
            Outcome::CloseFailed { error, not_removed } => {
                // Only the rows that are still there stay marked for the next close.
                self.inner.deletions.retain(&not_removed);
                Err(CatalogError::Cache(error))
            }
            Outcome::Cancelled => Err(CatalogError::Closed),
        };
        self.close_stage = CloseStage::Idle;
        self.closing = false;
        *self
            .close_result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result.clone());
        // A successful close is final: the thread ends once the result is recorded. A
        // failed one keeps the catalog usable, because its durable deletion markers are
        // exactly what a later close retries.
        if result.is_ok() {
            self.terminate = true;
        }
        for waiter in self.close_waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }
}
