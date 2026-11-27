// SPDX-License-Identifier: Apache-2.0
//! Registering, re-registering, invalidating and removing rows (`catalog.ts`), all on the
//! actor thread. A removal's deletion runs in a task that waits out the flights and writes
//! it drains; the actor settles its reservation when that task reports.

use std::sync::Arc;

use ace_models::instance::{Backend, ModelInstance};
use ace_protocol::generated::ProviderKind;
use futures::future::BoxFuture;

use crate::backoff::DiscoveryBackoff;
use crate::catalog::actor::{Actor, TaskKind};
use crate::catalog::commands::{Command, Envelope, Reply};
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
        let old_exists = self.inner.states.contains_key(&config.id);
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
        if !old_exists && of_kind >= kind_limit(config.provider) {
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
        if entry.is_some() && !compatible {
            let _ = self.deletions_remove(&config.id);
        }
        let old_entry_acp = self
            .inner
            .states
            .get(&config.id)
            .is_some_and(|old| old.entry.is_some() && old.config.provider == ProviderKind::Acp);
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
        if let Some(ids) = self.inner.providers.get_mut(&config.provider) {
            ids.retain(|id| id != &config.id);
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
                let _ = self.deletions_remove(&evicted);
                self.inner.persisted.remove(&evicted);
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
        self.inner.order.retain(|id| id != &config.id);
        self.inner.order.push(config.id.clone());
        self.inner
            .providers
            .entry(config.provider)
            .or_default()
            .push(config.id.clone());
        self.inner.persisted.remove(&config.id);
        self.inner.persisted_order.retain(|id| id != &config.id);
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
            self.notify_id(&id);
            self.refresh_after.insert(id.clone());
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
            self.notify_id(&id);
            self.refresh_after.insert(id.clone());
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
            known.waiters.push(reply);
            return;
        }
        if self.inner.removals.len() >= 128 {
            let _ = reply.send(Err(CatalogError::InstanceRemovalCapacity));
            return;
        }
        self.next_removal += 1;
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
        self.inner.order.retain(|id| id != &instance);
        self.inner.persisted.remove(&instance);
        self.inner.persisted_order.retain(|id| id != &instance);
        self.inner.acp_loaded.remove(&instance);
        self.inner.acp_spacing.forget(&instance);
        self.inner.removals.insert(
            instance.clone(),
            Removal {
                token,
                waiters: vec![reply],
            },
        );
        let storage = self.storage.clone();
        let commands = self.commands.clone();
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
            let mut storage = storage;
            let result = storage.remove(&id);
            let sender = commands
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = sender.send(Envelope {
                command: Command::RemovalDone {
                    id: id.clone(),
                    token,
                    result,
                },
                ack: None,
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

    pub(crate) fn removal_done(
        &mut self,
        id: &str,
        token: u64,
        result: Result<(), crate::cache::CacheError>,
    ) {
        let Some(removal) = self.inner.removals.get(id) else {
            return;
        };
        if removal.token != token {
            return;
        }
        let mut failure = result.err();
        match failure {
            Some(_) => self.inner.deletions.mark(id),
            None => {
                self.inner.deletions.forget(id);
                if let Some(error) = self.deletions_retry() {
                    failure = Some(error);
                }
            }
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
        self.inner.invalidations += selected.len();
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
                self.inner.invalidations = self.inner.invalidations.saturating_sub(1);
                continue;
            };
            if let Some(state) = self.inner.states.get_mut(&id) {
                state.entry = None;
                state.view = None;
            }
            if let Err(error) = self.register(config, admit) {
                self.inner.invalidations = self.inner.invalidations.saturating_sub(1);
                let remaining = self
                    .invalidation_batches
                    .remove(&batch)
                    .map(|batch| batch.reply);
                let _ = self.inner.invalidations.saturating_sub(0);
                if let Some(reply) = remaining {
                    let _ = reply.send(Err(error));
                }
                return;
            }
            self.next_invalidation += 1;
            let token = self.next_invalidation;
            let done = Gate::new();
            let place = self
                .inner
                .turns
                .entry(id.clone())
                .or_default()
                .accept_when_ready(PendingOp::Invalidation { token });
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
            let commands = self.commands.clone();
            let task_id = id.clone();
            let task: BoxFuture<'static, ()> = Box::pin(async move {
                if let Some(flight) = flight {
                    flight.wait().await;
                }
                if let Some(previous) = previous {
                    previous.wait().await;
                }
                let sender = commands
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let _ = sender.send(Envelope {
                    command: Command::InvalidationDone { id: task_id, token },
                    ack: None,
                });
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

    pub(crate) fn execute_invalidation(&mut self, id: &str, token: u64) {
        let Some(done) = self
            .inner
            .invalidating
            .get(id)
            .and_then(|pending| pending.iter().find(|pending| pending.token == token))
            .map(|pending| pending.done.clone())
        else {
            return;
        };
        let result = self.deletions_remove(id);
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
