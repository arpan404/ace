// SPDX-License-Identifier: Apache-2.0
//! Registering, re-registering, invalidating and removing rows (`catalog.ts`), all on the
//! actor thread. A removal's deletion runs in a task that waits out the flights and writes
//! it drains; the actor settles its reservation when that task reports.

use std::sync::Arc;

use ace_models::instance::{Backend, ModelInstance};
use ace_protocol::generated::ProviderKind;
use futures::future::BoxFuture;

use crate::backoff::DiscoveryBackoff;
use crate::catalog::actor::{Actor, DeleteWait, TaskKind};
use crate::catalog::commands::{Command, Reply};
use crate::catalog::storage_lane::Outcome;
use crate::catalog::{
    CatalogError, Invalidation, ModelFilter, PendingOp, Removal, State, identity_revision,
    selection, validate_instance,
};
use crate::gate::RefreshCause;
use crate::signals::Gate;

fn kind_limit(provider: ProviderKind) -> usize {
    if provider == ProviderKind::Acp {
        crate::cache::ACP_INSTANCE_LIMIT
    } else {
        crate::cache::CLI_INSTANCE_LIMIT
    }
}

fn is_acp(provider: ProviderKind) -> bool {
    provider == ProviderKind::Acp
}

impl Actor {
    pub(crate) fn register(
        &mut self,
        input: ModelInstance,
        admit: Option<crate::catalog::Admit>,
    ) -> Result<(), CatalogError> {
        validate_instance(&input)?;
        let runtime = match input.backend {
            Some(Backend::CursorSdk) => "cursor-sdk",
            _ => "cli",
        };
        let installed = self
            .inner
            .installations
            .get(&format!("{runtime}:{}", input.provider))
            .cloned();
        let config = match (&input.installation_version, installed) {
            (None, Some(version)) => ModelInstance {
                installation_version: Some(version),
                ..input
            },
            _ => input,
        };
        let revision = self.revision(&config);
        let identity = identity_revision(&config);
        let settings_key = settings_key(&self.configuration(&config));
        if self.inner.closed {
            return Err(CatalogError::Closed);
        }
        if self.inner.removals.contains_key(&config.id) {
            return Err(CatalogError::RemovalDraining);
        }
        let old_provider = self
            .inner
            .states
            .get(&config.id)
            .map(|old| old.config.provider);
        let old_exists = old_provider.is_some();
        let live = self
            .inner
            .providers
            .get(&ProviderKind::Acp)
            .map(Vec::len)
            .unwrap_or(0);
        let of_kind = if is_acp(config.provider) {
            live
        } else {
            self.inner.states.len() - live
        };
        if of_kind >= kind_limit(config.provider)
            && old_provider.is_none_or(|provider| is_acp(provider) != is_acp(config.provider))
        {
            return Err(CatalogError::InstanceLimit);
        }
        let old_entry = self
            .inner
            .states
            .get(&config.id)
            .and_then(|state| state.entry.clone());
        let entry = old_entry
            .clone()
            .or_else(|| self.inner.persisted.get(&config.id).cloned().map(Arc::new));
        let compatible = entry.as_ref().is_some_and(|entry| {
            entry.provider == config.provider
                && match self.inner.states.get(&config.id) {
                    Some(old) => identity_revision(&old.config) == identity,
                    None => {
                        entry.identity_revision.as_deref() == Some(identity.as_str())
                            || ((entry.identity_revision.is_none()
                                || config.provider == ProviderKind::Acp)
                                && entry.revision == revision)
                    }
                }
        });
        let identity_changed = self
            .inner
            .states
            .get(&config.id)
            .is_some_and(|old| identity_revision(&old.config) != identity);
        let replacing_write = self.has_replace(&config.id);
        if (entry.is_some() && !compatible || replacing_write && identity_changed)
            && !self.begin_delete(&config.id)
        {
            return Err(CatalogError::Busy);
        }
        self.cancel_replace(&config.id);
        let old_entry_acp = self
            .inner
            .states
            .get(&config.id)
            .is_some_and(|old| old.entry.is_some() && old.config.provider == ProviderKind::Acp);
        // A replacement, a login change or a revocation owns the old row's probe: its
        // signal, timer, waiters and capacity are freed before it can hang on.
        self.abort_rows_probe(&config.id);
        if let Some(abort) = self
            .inner
            .states
            .get(&config.id)
            .and_then(|old| old.abort.clone())
        {
            abort.abort();
        }
        if old_entry_acp {
            self.inner.acp_loaded.insert(config.id.clone());
        }
        // A full kind evicts its own oldest cached row, never the other kind's.
        if !old_exists && !self.inner.persisted.contains_key(&config.id) {
            let mut cached: Vec<String> = self
                .inner
                .persisted_order
                .iter()
                .filter(|id| {
                    self.inner
                        .persisted
                        .get(*id)
                        .is_some_and(|entry| is_acp(entry.provider) == is_acp(config.provider))
                })
                .cloned()
                .collect();
            if of_kind + cached.len() >= kind_limit(config.provider)
                && let Some(evicted) = cached.drain(..1).next()
            {
                if !self.begin_delete(&evicted) {
                    return Err(CatalogError::Busy);
                }
                self.inner.persisted.remove(&evicted);
                self.inner.acp_loaded.remove(&evicted);
                self.inner.persisted_order.retain(|id| id != &evicted);
            }
        }
        let admit = admit.or_else(|| {
            self.inner
                .states
                .get(&config.id)
                .and_then(|state| state.admit.clone())
        });
        let entry = compatible.then_some(entry).flatten();
        let dirty = entry
            .as_ref()
            .is_some_and(|entry| entry.revision != revision);
        self.inner.next_generation += 1;
        let generation = self.inner.next_generation;
        let restored = entry.is_some() && !old_exists && config.provider != ProviderKind::Acp;
        let state = State {
            config: config.clone(),
            permission_modes: None,
            admit,
            entry: entry.clone(),
            error: None,
            error_detail: None,
            dirty,
            no_model_sources: None,
            unconfigured_at: None,
            retry_at: 0.0,
            backoff: DiscoveryBackoff::new(),
            connection_fingerprint: entry
                .as_ref()
                .and_then(|entry| entry.connection_revision.clone()),
            probe_retry_at: 0.0,
            settings_key,
            flight: None,
            flight_token: None,
            probe_revision: None,
            probe: None,
            acp_due: false,
            generation,
            abort: None,
            view: None,
        };
        self.inner.states.insert(config.id.clone(), state);
        if let Some(provider) = old_provider
            && let Some(ids) = self.inner.providers.get_mut(&provider)
        {
            ids.retain(|id| id != &config.id);
        }
        self.inner.order.retain(|id| id != &config.id);
        self.inner.order.push(config.id.clone());
        self.instance_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(config.id.clone());
        self.inner
            .providers
            .entry(config.provider)
            .or_default()
            .push(config.id.clone());
        self.inner.persisted.remove(&config.id);
        self.inner.persisted_order.retain(|id| id != &config.id);
        self.cancel_obsolete_commits(&config.id);
        if restored {
            // A restored CLI row is served as it is and replaced in the background.
            self.start_flight(&config.id.clone(), RefreshCause::Background);
        }
        self.notify(&config);
        Ok(())
    }

    pub(crate) fn mark_stale(&mut self, filter: &ModelFilter) -> Result<(), CatalogError> {
        if self.inner.closed {
            return Err(CatalogError::Closed);
        }
        let mut changes = Vec::new();
        for id in selection(&self.inner, filter) {
            let Some(state) = self.inner.states.get_mut(&id) else {
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
        for config in &changes {
            self.notify(config);
        }
        Ok(())
    }

    pub(crate) fn configuration_changed(&mut self) {
        let mut refreshed = Vec::new();
        let ids: Vec<String> = self.inner.states.keys().cloned().collect();
        for id in ids {
            let Some(config) = self.inner.states.get(&id).map(|state| state.config.clone()) else {
                continue;
            };
            let settings_key = settings_key(&self.configuration(&config));
            let revision = self.revision(&config);
            let enabled = self.enabled(&config);
            let Some(state) = self.inner.states.get_mut(&id) else {
                continue;
            };
            if settings_key == state.settings_key {
                continue;
            }
            state.settings_key = settings_key;
            state.view = None;
            state.dirty = true;
            state.probe_retry_at = 0.0;
            state.backoff.reset();
            state.retry_at = 0.0;
            if (!enabled
                || state
                    .probe_revision
                    .as_ref()
                    .is_some_and(|probe| probe != &revision))
                && let Some(abort) = &state.abort
            {
                abort.abort();
            }
            if state
                .entry
                .as_ref()
                .is_some_and(|entry| entry.revision != revision)
            {
                if let Some(abort) = &state.abort {
                    abort.abort();
                }
                state.dirty = true;
                state.probe_retry_at = 0.0;
                state.backoff.reset();
                state.retry_at = 0.0;
            }
            refreshed.push(id);
        }
        for id in refreshed {
            self.cancel_stale_replace(&id);
            self.notify_id(&id);
            self.refresh_after.insert(id.clone());
            self.cancel_obsolete_commits(&id);
            if self
                .inner
                .states
                .get(&id)
                .is_some_and(|state| state.flight.is_none())
            {
                self.refresh_after.remove(&id);
                self.start_flight(&id, RefreshCause::Background);
            }
        }
    }

    pub(crate) fn installation_changed(
        &mut self,
        provider: ProviderKind,
        version: &str,
        runtime: &str,
    ) {
        if !matches!(runtime, "cli" | "cursor-sdk") || version.chars().count() > 4096 {
            return;
        }
        self.inner
            .installations
            .insert(format!("{runtime}:{provider}"), version.to_owned());
        let ids = self
            .inner
            .providers
            .get(&provider)
            .cloned()
            .unwrap_or_default();
        let mut changed = Vec::new();
        for id in ids {
            let Some(state) = self.inner.states.get_mut(&id) else {
                continue;
            };
            let state_runtime = match state.config.backend {
                Some(Backend::CursorSdk) => "cursor-sdk",
                _ => "cli",
            };
            if state_runtime != runtime
                || state.config.installation_version.as_deref() == Some(version)
            {
                continue;
            }
            state.config.installation_version = Some(version.to_owned());
            state.dirty = true;
            state.probe_retry_at = 0.0;
            state.backoff.reset();
            state.retry_at = 0.0;
            if let Some(abort) = &state.abort {
                abort.abort();
            }
            changed.push(id);
        }
        for id in changed {
            self.cancel_stale_replace(&id);
            self.notify_id(&id);
            self.refresh_after.insert(id.clone());
            self.cancel_obsolete_commits(&id);
            if self
                .inner
                .states
                .get(&id)
                .is_some_and(|state| state.flight.is_none())
            {
                self.refresh_after.remove(&id);
                self.start_flight(&id, RefreshCause::Background);
            }
        }
    }

    pub(crate) fn login_changed(
        &mut self,
        instance: &str,
        revision: &str,
        sign_in_method: Option<Option<String>>,
    ) -> Result<Option<Vec<crate::catalog::InstanceStatus>>, CatalogError> {
        let Some(config) = self
            .inner
            .states
            .get(instance)
            .map(|state| state.config.clone())
        else {
            return Err(CatalogError::UnknownInstance);
        };
        let method = match sign_in_method {
            Some(value) => value,
            None => config.sign_in_method.clone(),
        };
        let next = ModelInstance {
            login_revision: revision.to_owned(),
            sign_in_method: method,
            ..config
        };
        self.register(next, None)?;
        if self
            .inner
            .states
            .get(instance)
            .map(|state| state.config.provider)
            != Some(ProviderKind::Acp)
        {
            return Ok(None);
        }
        if let Some(state) = self.inner.states.get_mut(instance) {
            state.acp_due = true;
        }
        self.notify_id(instance);
        Ok(Some(self.status(instance).into_iter().collect()))
    }

    pub(crate) fn remove(&mut self, instance: String, reply: Reply<Result<(), CatalogError>>) {
        if self.inner.closed {
            let _ = reply.send(Err(CatalogError::Closed));
            return;
        }
        if let Some(known) = self.inner.removals.get_mut(&instance) {
            known.waiters.retain(|waiter| !waiter.is_canceled());
            if known.waiters.len() >= crate::catalog::WAITER_LIMIT {
                let _ = reply.send(Err(CatalogError::Busy));
            } else {
                known.waiters.push(reply);
            }
            return;
        }
        if !(1..=256).contains(&instance.chars().count()) {
            let _ = reply.send(Err(CatalogError::InvalidInstance));
            return;
        }
        if self.inner.removals.len() >= 128 || self.removal_tasks >= 128 {
            let _ = reply.send(Err(CatalogError::InstanceRemovalCapacity));
            return;
        }
        // A removal that fails keeps its durable marker, so the set must have room for
        // this row before the row is withdrawn from memory.
        if !self.inner.deletions.reserve(&instance) {
            let _ = reply.send(Err(CatalogError::InstanceRemovalCapacity));
            return;
        }
        self.cancel_replace(&instance);
        self.next_removal += 1;
        self.removal_tasks += 1;
        let token = self.next_removal;
        // Every flight this instance ever started, not only its current row's.
        let mut flights: Vec<Gate> = self
            .inner
            .row_flights
            .get(&instance)
            .map(|gates| gates.iter().map(|flight| flight.done.clone()).collect())
            .unwrap_or_default();
        let mut invalidating = None;
        let tail = self
            .inner
            .turns
            .get(&instance)
            .and_then(crate::catalog::Turns::tail);
        self.abort_rows_probe(&instance);
        if let Some(state) = self.inner.states.get_mut(&instance) {
            if let Some(abort) = &state.abort {
                abort.abort();
            }
            if let Some(flight) = &state.flight {
                flights.push(flight.done.clone());
            }
        }
        if let Some(pending) = self
            .inner
            .invalidating
            .get(&instance)
            .and_then(|pending| pending.last())
        {
            invalidating = Some(pending.done.clone());
        }
        if let Some(ids) = self
            .inner
            .states
            .get(&instance)
            .and_then(|state| self.inner.providers.get_mut(&state.config.provider))
        {
            ids.retain(|id| id != &instance);
        }
        self.inner.states.remove(&instance);
        self.refresh_after.remove(&instance);
        self.inner.order.retain(|id| id != &instance);
        self.instance_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&instance);
        self.inner.persisted.remove(&instance);
        self.inner.persisted_order.retain(|id| id != &instance);
        self.inner.acp_loaded.remove(&instance);
        self.inner.acp_spacing.forget(&instance);
        self.inner.removals.insert(
            instance.clone(),
            Removal {
                token,
                started: false,
                waiters: vec![reply],
            },
        );
        self.cancel_obsolete_commits(&instance);
        let reporter = self.reporter.clone();
        let id = instance.clone();
        let task: BoxFuture<'static, ()> = Box::pin(async move {
            for flight in flights {
                flight.wait().await;
            }
            if let Some(pending) = invalidating {
                pending.wait().await;
            }
            if let Some(tail) = tail {
                tail.wait().await;
            }
            reporter.report(Command::RemovalReady {
                id: id.clone(),
                token,
            });
        });
        self.spawn(
            TaskKind::Removal {
                id: instance,
                token,
            },
            task,
        );
    }

    /// A removal's flights are drained: its durable delete goes to the lane.
    pub(crate) fn removal_ready(&mut self, id: &str, token: u64) {
        let Some(removal) = self.inner.removals.get_mut(id) else {
            return;
        };
        if removal.token != token || removal.started {
            return;
        }
        removal.started = true;
        self.await_delete(id, DeleteWait::Removal { token });
    }

    pub(crate) fn removal_done(&mut self, id: &str, token: u64, outcome: Outcome) {
        let Some(removal) = self.inner.removals.get(id) else {
            return;
        };
        if removal.token != token {
            return;
        }
        let failure = match outcome {
            Outcome::Done => None,
            Outcome::Failed(error) | Outcome::CloseFailed { error, .. } => Some(error),
            Outcome::Cancelled => Some(crate::cache::CacheError::Malformed),
        };
        if failure.is_none() && !self.inner.closed {
            self.retry_pending_deletions();
        }
        let settled = match failure {
            Some(error) => Err(CatalogError::Cache(error)),
            None => Ok(()),
        };
        let Some(removal) = self.inner.removals.remove(id) else {
            return;
        };
        for waiter in removal.waiters {
            let _ = waiter.send(settled.clone());
        }
    }

    /// Retries every pending deletion on the lane after one removal freed its id.
    fn retry_pending_deletions(&mut self) {
        for id in self.inner.deletions.pending_ids() {
            self.begin_delete(&id);
        }
    }

    pub(crate) fn invalidate(
        &mut self,
        filter: ModelFilter,
        reply: Reply<Result<(), CatalogError>>,
    ) {
        if self.inner.closed {
            let _ = reply.send(Err(CatalogError::Closed));
            return;
        }
        let selected = selection(&self.inner, &filter);
        if self.inner.invalidations + selected.len() > 128 {
            let _ = reply.send(Err(CatalogError::InvalidationCapacity));
            return;
        }
        self.next_invalidation_batch += 1;
        let batch = self.next_invalidation_batch;
        self.invalidation_batches.insert(
            batch,
            crate::catalog::actor::InvalidationBatch {
                remaining: 0,
                error: None,
                reply,
            },
        );
        for id in selected {
            let captured = self.inner.states.get(&id).and_then(|state| {
                if state.config.provider == ProviderKind::Acp {
                    return None;
                }
                Some((
                    state.config.clone(),
                    state.admit.clone(),
                    state.flight.as_ref().map(|flight| flight.done.clone()),
                    self.inner
                        .invalidating
                        .get(&id)
                        .and_then(|pending| pending.last())
                        .map(|pending| pending.done.clone()),
                ))
            });
            let Some((config, admit, flight, previous)) = captured else {
                continue;
            };
            if let Some(state) = self.inner.states.get_mut(&id) {
                state.entry = None;
                state.view = None;
            }
            if let Err(error) = self.register(config, admit) {
                let remaining = self
                    .invalidation_batches
                    .remove(&batch)
                    .map(|batch| batch.reply);
                if let Some(reply) = remaining {
                    let _ = reply.send(Err(error));
                }
                return;
            }
            self.inner.invalidations += 1;
            self.next_invalidation += 1;
            let token = self.next_invalidation;
            let done = Gate::new();
            let place = self.next_place();
            self.inner
                .turns
                .entry(id.clone())
                .or_default()
                .accept_when_ready(place, PendingOp::Invalidation { token });
            self.inner
                .invalidating
                .entry(id.clone())
                .or_default()
                .push(Invalidation {
                    token,
                    done: done.clone(),
                    place,
                });
            self.invalidation_batch_of.insert(token, batch);
            if let Some(batch) = self.invalidation_batches.get_mut(&batch) {
                batch.remaining += 1;
            }
            let task: BoxFuture<'static, ()> = Box::pin(async move {
                if let Some(flight) = flight {
                    flight.wait().await;
                }
                if let Some(previous) = previous {
                    previous.wait().await;
                }
            });
            self.spawn(
                TaskKind::Invalidation {
                    id: id.clone(),
                    token,
                },
                task,
            );
        }
        let done = self
            .invalidation_batches
            .get(&batch)
            .is_some_and(|batch| batch.remaining == 0);
        if done && let Some(batch) = self.invalidation_batches.remove(&batch) {
            let _ = batch.reply.send(Ok(()));
        }
    }

    pub(crate) fn mark_invalidation_ready(&mut self, id: &str, token: u64) {
        let Some(place) = self
            .inner
            .invalidating
            .get(id)
            .and_then(|pending| pending.iter().find(|pending| pending.token == token))
            .map(|pending| pending.place)
        else {
            return;
        };
        if let Some(turns) = self.inner.turns.get_mut(id) {
            turns.mark_ready(place);
        }
        self.pump(id);
    }

    /// The deletion a revocation runs, dispatched from its queue place.
    pub(crate) fn begin_invalidation(&mut self, id: &str, token: u64, place: u64) -> bool {
        if self
            .inner
            .invalidating
            .get(id)
            .and_then(|pending| pending.iter().find(|pending| pending.token == token))
            .is_none()
        {
            return true;
        }
        self.await_delete(id, DeleteWait::Invalidation { token, place });
        false
    }

    pub(crate) fn invalidation_removed(
        &mut self,
        id: &str,
        token: u64,
        place: u64,
        outcome: Outcome,
    ) {
        let result = match outcome {
            Outcome::Done => Ok(()),
            Outcome::Failed(error) | Outcome::CloseFailed { error, .. } => Err(error),
            Outcome::Cancelled => Err(crate::cache::CacheError::Malformed),
        };
        let Some(done) = self
            .inner
            .invalidating
            .get(id)
            .and_then(|pending| pending.iter().find(|pending| pending.token == token))
            .map(|pending| pending.done.clone())
        else {
            self.settle_place(id, place);
            return;
        };
        if let Some(pending) = self.inner.invalidating.get_mut(id) {
            pending.retain(|pending| pending.token != token);
            if pending.is_empty() {
                self.inner.invalidating.remove(id);
            }
        }
        done.open();
        self.inner.invalidations = self.inner.invalidations.saturating_sub(1);
        let batch = self.invalidation_batch_of.remove(&token);
        if let Some(batch) = batch
            && let Some(entry) = self.invalidation_batches.get_mut(&batch)
        {
            if entry.error.is_none() {
                entry.error = result.err();
            }
            entry.remaining = entry.remaining.saturating_sub(1);
            if entry.remaining == 0
                && let Some(entry) = self.invalidation_batches.remove(&batch)
            {
                let reply = match entry.error {
                    Some(error) => Err(CatalogError::Cache(error)),
                    None => Ok(()),
                };
                let _ = entry.reply.send(reply);
            }
        }
        self.settle_place(id, place);
    }
}

pub(crate) fn settings_key(config: &crate::preferences::ProviderConfig) -> String {
    serde_json::to_string(&serde_json::json!({
        "provider": config.provider,
        "instance": config.instance,
        "enabled": config.enabled,
        "defaultModel": config.default_model,
        "binaryPath": config.binary_path,
        "customModels": config.custom_models.iter().map(|model| (&model.id, &model.display_name)).collect::<Vec<_>>(),
        "hiddenModels": config.hidden_models,
        "shownModels": config.shown_models,
        "hiddenGroups": config.hidden_groups,
        "shownGroups": config.shown_groups,
        "favourites": config.favourites,
        "showOnlyFavourites": config.show_only_favourites,
        "hideDeprecated": config.hide_deprecated,
    }))
    .unwrap_or_default()
}
