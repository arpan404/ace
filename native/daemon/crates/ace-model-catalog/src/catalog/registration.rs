// SPDX-License-Identifier: Apache-2.0
//! Registering, re-registering, invalidating and removing rows (`catalog.ts`).

use std::sync::Arc;

use ace_models::instance::{Backend, ModelInstance};
use ace_protocol::generated::ProviderKind;

use crate::backoff::DiscoveryBackoff;
use crate::catalog::{
    Admit, Catalog, CatalogError, InstanceStatus, ModelFilter, State, fresh_status,
    identity_revision, validate_instance,
};
use crate::gate::RefreshCause;

/// The most rows of one kind: 64 CLI accounts, 512 ACP agents.
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

impl Catalog {
    /// Registers an instance, restoring a compatible cached row.
    pub fn register_instance(
        &self,
        input: ModelInstance,
        admit: Option<Admit>,
    ) -> Result<(), CatalogError> {
        validate_instance(&input)?;
        let runtime = match input.backend {
            Some(Backend::CursorSdk) => "cursor-sdk",
            _ => "cli",
        };
        let installed = self.with_inner(|inner| {
            inner
                .installations
                .get(&format!("{runtime}:{}", input.provider))
                .cloned()
        });
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
        let (registered, restored) = self.with_inner(|inner| {
            if inner.closed {
                return Err(CatalogError::Closed);
            }
            if inner.removals.contains(&config.id) {
                return Err(CatalogError::RemovalDraining);
            }
            let old = inner.states.get(&config.id);
            let live = inner
                .providers
                .get(&ProviderKind::Acp)
                .map(Vec::len)
                .unwrap_or(0);
            let of_kind = if is_acp(config.provider) {
                live
            } else {
                inner.states.len() - live
            };
            if old.is_none() && of_kind >= kind_limit(config.provider) {
                return Err(CatalogError::InstanceLimit);
            }
            let entry = old
                .and_then(|state| state.entry.clone())
                .or_else(|| inner.persisted.get(&config.id).cloned().map(Arc::new));
            let compatible = entry.as_ref().is_some_and(|entry| {
                entry.provider == config.provider
                    && match old {
                        Some(old) => identity_revision(&old.config) == identity,
                        None => {
                            entry.identity_revision.as_deref() == Some(identity.as_str())
                                || ((entry.identity_revision.is_none()
                                    || config.provider == ProviderKind::Acp)
                                    && entry.revision == revision)
                        }
                    }
            });
            // A failed removal stays pending for the next retry.
            if entry.is_some() && !compatible {
                let _ = inner.deletions.remove(&config.id);
            }
            let old_entry_acp = old
                .is_some_and(|old| old.entry.is_some() && old.config.provider == ProviderKind::Acp);
            if let Some(abort) = old.and_then(|old| old.abort.clone()) {
                abort.abort();
            }
            if old_entry_acp {
                inner.acp_loaded.insert(config.id.clone());
            }
            if let Some(ids) = inner.providers.get_mut(&config.provider) {
                ids.retain(|id| id != &config.id);
            }
            // A full kind evicts its own oldest cached row, never the other kind's.
            if old.is_none() && !inner.persisted.contains_key(&config.id) {
                let mut cached: Vec<String> = inner
                    .persisted_order
                    .iter()
                    .filter(|id| {
                        inner
                            .persisted
                            .get(*id)
                            .is_some_and(|entry| is_acp(entry.provider) == is_acp(config.provider))
                    })
                    .cloned()
                    .collect();
                if of_kind + cached.len() >= kind_limit(config.provider)
                    && let Some(evicted) = cached.drain(..1).next()
                {
                    let _ = inner.deletions.remove(&evicted);
                    inner.persisted.remove(&evicted);
                    inner.persisted_order.retain(|id| id != &evicted);
                }
            }
            let admit = admit.or_else(|| {
                inner
                    .states
                    .get(&config.id)
                    .and_then(|state| state.admit.clone())
            });
            let entry = compatible.then_some(entry).flatten();
            let dirty = entry
                .as_ref()
                .is_some_and(|entry| entry.revision != revision);
            inner.next_generation += 1;
            let generation = inner.next_generation;
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
                invalidating: None,
                flight: None,
                flight_token: None,
                probe_revision: None,
                acp_due: false,
                generation,
                abort: None,
                view: None,
            };
            let restored = entry.is_some() && old.is_none() && config.provider != ProviderKind::Acp;
            inner.states.insert(config.id.clone(), state);
            inner.order.retain(|id| id != &config.id);
            inner.order.push(config.id.clone());
            inner
                .providers
                .entry(config.provider)
                .or_default()
                .push(config.id.clone());
            inner.persisted.remove(&config.id);
            inner.persisted_order.retain(|id| id != &config.id);
            Ok((config, restored))
        })?;
        if restored {
            // A restored CLI row is served as it is and replaced in the background.
            self.spawn_refresh(registered.id.clone(), RefreshCause::Background);
        }
        self.notify_config(&registered);
        Ok(())
    }

    /// A sign-in changed: the old account's choices are gone immediately.
    pub async fn login_changed(
        &self,
        instance: &str,
        revision: &str,
        sign_in_method: Option<Option<String>>,
    ) -> Result<Vec<InstanceStatus>, CatalogError> {
        let config = self
            .registered(instance)
            .ok_or(CatalogError::UnknownInstance)?;
        let method = match sign_in_method {
            Some(value) => value,
            None => config.sign_in_method.clone(),
        };
        let mut next = ModelInstance {
            login_revision: revision.to_owned(),
            sign_in_method: method,
            ..config
        };
        if next.sign_in_method.is_none() {
            next.sign_in_method = None;
        }
        self.register_instance(next, None)?;
        if self.registered(instance).map(|config| config.provider) != Some(ProviderKind::Acp) {
            return self.refresh(ModelFilter::instance(instance)).await;
        }
        let statuses = self.with_inner(|inner| {
            if let Some(state) = inner.states.get_mut(instance) {
                state.acp_due = true;
            }
            inner
                .states
                .get(instance)
                .map(|state| vec![self.status(state)])
                .unwrap_or_default()
        });
        Ok(statuses)
    }

    /// Removes a row: state, cached choices, and a flush of in-flight discovery.
    pub async fn remove_instance(&self, instance: &str) -> Result<(), CatalogError> {
        let (flights, invalidations, tail) = self.with_inner(|inner| {
            let removal = inner.removals.contains(instance);
            if removal {
                return (Vec::new(), Vec::new(), None);
            }
            if inner.removals.len() >= 128 {
                return (Vec::new(), Vec::new(), None);
            }
            inner.removals.insert(instance.to_owned());
            let mut flights = Vec::new();
            let mut invalidations = Vec::new();
            let tail = inner.write_tails.get(instance).cloned();
            if let Some(state) = inner.states.get(instance) {
                if let Some(abort) = &state.abort {
                    abort.abort();
                }
                if let Some(flight) = &state.flight {
                    flights.push(flight.clone());
                }
                if let Some(pending) = &state.invalidating {
                    invalidations.push(pending.clone());
                }
            }
            if let Some(ids) = inner
                .states
                .get(instance)
                .and_then(|state| inner.providers.get_mut(&state.config.provider))
            {
                ids.retain(|id| id != instance);
            }
            inner.states.remove(instance);
            inner.order.retain(|id| id != instance);
            inner.persisted.remove(instance);
            inner.persisted_order.retain(|id| id != instance);
            inner.acp_loaded.remove(instance);
            inner.acp_spacing.forget(instance);
            (flights, invalidations, tail)
        });
        for flight in flights {
            flight.done.wait().await;
        }
        for pending in invalidations {
            pending.done.wait().await;
        }
        if let Some(tail) = tail {
            tail.wait().await;
        }
        let _ = self.with_inner(|inner| inner.deletions.remove(instance));
        let retried = self.with_inner(|inner| inner.deletions.retry());
        let removed = self.with_inner(|inner| {
            inner.removals.remove(instance);
            true
        });
        let _ = removed;
        match retried.into_iter().find(|result| result.is_err()) {
            Some(Err(error)) => Err(CatalogError::Cache(error)),
            _ => Ok(()),
        }
    }

    /// Account-change boundary: revoke choices immediately, then delete them.
    pub async fn invalidate(&self, filter: ModelFilter) -> Result<(), CatalogError> {
        let selected = {
            let mut inner = crate::catalog::lock(&self.inner);
            if inner.closed {
                return Err(CatalogError::Closed);
            }
            let selected = crate::catalog::selection_for(&mut inner, &filter);
            if inner.invalidations + selected.len() > 128 {
                return Err(CatalogError::InvalidationCapacity);
            }
            inner.invalidations += selected.len();
            selected
        };
        let mut pending = Vec::new();
        for id in &selected {
            let captured = self.with_inner(|inner| {
                let state = inner.states.get_mut(id)?;
                if state.config.provider == ProviderKind::Acp {
                    return None;
                }
                state.entry = None;
                state.view = None;
                let flights = state.flight.clone();
                let invalidations = state.invalidating.clone();
                let tail = inner.write_tails.get(id).cloned();
                Some((
                    state.config.clone(),
                    state.admit.clone(),
                    flights,
                    invalidations,
                    tail,
                ))
            });
            let Some((config, admit, flights, invalidations, tail)) = captured else {
                continue;
            };
            self.register_instance(config, admit)?;
            let catalog = self.clone();
            let id = id.clone();
            let done = crate::signals::Gate::new();
            let barrier = crate::signals::Gate::new();
            self.with_inner(|inner| {
                if let Some(state) = inner.states.get_mut(&id) {
                    state.invalidating = Some(crate::catalog::Flight {
                        done: done.clone(),
                        token: 0,
                        generation: state.generation,
                    });
                }
                // The deletion outlives this row: a replacement's write waits for it.
                inner.deletion_gates.insert(id.clone(), barrier.clone());
            });
            pending.push(Box::pin(async move {
                if let Some(flight) = flights {
                    flight.done.wait().await;
                }
                if let Some(pending) = invalidations {
                    pending.done.wait().await;
                }
                if let Some(tail) = tail {
                    tail.wait().await;
                }
                let removed = catalog.with_inner(|inner| inner.deletions.remove(&id));
                catalog.with_inner(|inner| {
                    if inner
                        .deletion_gates
                        .get(&id)
                        .is_some_and(|current| current.same(&barrier))
                    {
                        inner.deletion_gates.remove(&id);
                    }
                });
                barrier.open();
                done.open();
                removed
            }));
        }
        let results = futures::future::join_all(pending).await;
        self.with_inner(|inner| {
            inner.invalidations = inner.invalidations.saturating_sub(selected.len());
        });
        // A revocation that could not delete its row says so; the deletion stays pending.
        match results.into_iter().find(|result| result.is_err()) {
            Some(Err(error)) => Err(CatalogError::Cache(error)),
            _ => Ok(()),
        }
    }

    /// Settings changed: rows whose effective configuration changed are fenced and refreshed.
    pub fn configuration_changed(&self) {
        let refreshed = self.with_inner(|inner| {
            let mut refreshed = Vec::new();
            for state in inner.states.values_mut() {
                let settings_key = settings_key(&self.configuration(&state.config));
                if settings_key == state.settings_key {
                    continue;
                }
                state.settings_key = settings_key;
                state.view = None;
                state.dirty = true;
                state.probe_retry_at = 0.0;
                state.backoff.reset();
                state.retry_at = 0.0;
                if (!self.enabled(&state.config)
                    || state
                        .probe_revision
                        .as_ref()
                        .is_some_and(|revision| revision != &self.revision(&state.config)))
                    && let Some(abort) = &state.abort
                {
                    abort.abort();
                }
                if state
                    .entry
                    .as_ref()
                    .is_some_and(|entry| entry.revision != self.revision(&state.config))
                {
                    if let Some(abort) = &state.abort {
                        abort.abort();
                    }
                    state.dirty = true;
                    state.probe_retry_at = 0.0;
                    state.backoff.reset();
                    state.retry_at = 0.0;
                }
                refreshed.push((state.config.id.clone(), state.flight.clone()));
            }
            refreshed
        });
        for (id, flight) in refreshed {
            if let Some(config) = self.registered(&id) {
                self.notify_config(&config);
            }
            let catalog = self.clone();
            self.options.spawn.spawn(Box::pin(async move {
                if let Some(flight) = flight {
                    flight.done.wait().await;
                }
                if catalog.has_instance(&id) {
                    let _ = catalog.refresh_state(&id, RefreshCause::Background).await;
                }
            }));
        }
    }

    /// A provider's installed version changed for this runtime.
    pub fn installation_changed(&self, provider: ProviderKind, version: &str, runtime: &str) {
        let changed = self.with_inner(|inner| {
            inner
                .installations
                .insert(format!("{runtime}:{provider}"), version.to_owned());
            let ids = inner.providers.get(&provider).cloned().unwrap_or_default();
            let mut changed = Vec::new();
            for id in ids {
                let Some(state) = inner.states.get_mut(&id) else {
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
                changed.push((id, state.flight.clone()));
            }
            changed
        });
        for (id, flight) in changed {
            if let Some(config) = self.registered(&id) {
                self.notify_config(&config);
            }
            let catalog = self.clone();
            self.options.spawn.spawn(Box::pin(async move {
                if let Some(flight) = flight {
                    flight.done.wait().await;
                }
                if catalog.has_instance(&id) {
                    let _ = catalog.refresh_state(&id, RefreshCause::Background).await;
                }
            }));
        }
    }

    /// The statuses an explicit refresh reports.
    pub async fn refresh(&self, filter: ModelFilter) -> Result<Vec<InstanceStatus>, CatalogError> {
        if self.with_inner(|inner| inner.closed) {
            return Err(CatalogError::Closed);
        }
        let ids = self.selection(&filter);
        // Each instance's flight runs independently: one slow provider never holds
        // another instance's refresh, as `Promise.all` does in the TypeScript.
        let statuses = futures::future::join_all(ids.into_iter().map(|id| {
            let catalog = self.clone();
            async move {
                let is_acp = catalog
                    .registered(&id)
                    .is_some_and(|config| config.provider == ProviderKind::Acp);
                if is_acp {
                    catalog.with_inner(|inner| {
                        if let Some(state) = inner.states.get_mut(&id) {
                            state.acp_due = true;
                            state.dirty = true;
                        }
                    });
                    if let Some(config) = catalog.registered(&id) {
                        catalog.notify_config(&config);
                    }
                    return fresh_status(&catalog, &id);
                }
                Some(catalog.refresh_current(&id, RefreshCause::Background).await)
            }
        }))
        .await;
        Ok(statuses.into_iter().flatten().collect())
    }

    /// The person asked for one row's models (Load models).
    pub async fn load(&self, instance: &str) -> Result<Vec<InstanceStatus>, CatalogError> {
        if self.with_inner(|inner| inner.closed) {
            return Err(CatalogError::Closed);
        }
        let Some(config) = self.registered(instance) else {
            return Ok(Vec::new());
        };
        if config.provider != ProviderKind::Acp {
            return self.refresh(ModelFilter::instance(instance)).await;
        }
        Ok(vec![
            self.refresh_state(instance, RefreshCause::Request).await,
        ])
    }

    /// Waits for rows that never loaded, or loaded empty and are due.
    pub async fn load_missing(
        &self,
        filter: ModelFilter,
    ) -> Result<Vec<InstanceStatus>, CatalogError> {
        if self.with_inner(|inner| inner.closed) {
            return Err(CatalogError::Closed);
        }
        let ids = self.selection(&filter);
        let due: Vec<String> = self.with_inner(|inner| {
            ids.into_iter()
                .filter(|id| {
                    inner.states.get(id).is_some_and(|state| {
                        state.entry.is_none()
                            || (state
                                .entry
                                .as_ref()
                                .is_some_and(|entry| entry.models.is_empty())
                                && (state.flight.is_some() || self.stale(state)))
                    })
                })
                .collect()
        });
        let statuses = futures::future::join_all(due.into_iter().map(|id| {
            let catalog = self.clone();
            async move { catalog.refresh_state(&id, RefreshCause::Read).await }
        }))
        .await;
        Ok(statuses)
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
