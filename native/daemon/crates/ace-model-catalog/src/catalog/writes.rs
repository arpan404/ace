// SPDX-License-Identifier: Apache-2.0
//! Writes that come from a session (`catalog.ts` `updateFromSession`,
//! `updatePermissionModes`): one queue per instance, so a write is built on the entry
//! the write before it left.

use std::sync::Arc;

use ace_models::instance::ModelInstance;
use serde_json::Value;

use crate::cache::CacheEntry;
use crate::catalog::{Catalog, CatalogError, identity_revision, validate_instance};
use crate::signals::Gate;

/// The place one write holds in an instance's queue.
pub(crate) struct Release {
    catalog: Catalog,
    id: String,
    gate: Gate,
}

impl Drop for Release {
    fn drop(&mut self) {
        self.gate.open();
        self.catalog.with_inner(|inner| {
            if inner
                .write_tails
                .get(&self.id)
                .is_some_and(|current| current.same(&self.gate))
            {
                inner.write_tails.remove(&self.id);
            }
        });
    }
}

impl Catalog {
    /// Takes this instance's place in the write queue, after every write before it.
    pub(crate) async fn hold_writes(&self, id: &str) -> Release {
        let previous = self.with_inner(|inner| inner.write_tails.get(id).cloned());
        if let Some(previous) = previous {
            previous.wait().await;
        }
        let gate = Gate::new();
        self.with_inner(|inner| {
            inner.write_tails.insert(id.to_owned(), gate.clone());
        });
        Release {
            catalog: self.clone(),
            id: id.to_owned(),
            gate,
        }
    }

    /// Metadata from an already authorized session. No process or inference starts.
    pub async fn update_from_session(
        &self,
        input: ModelInstance,
        metadata: &Value,
    ) -> Result<(), CatalogError> {
        if self.with_inner(|inner| inner.closed) {
            return Err(CatalogError::Closed);
        }
        if self.with_inner(|inner| inner.session_writes) >= 64 {
            return Err(CatalogError::SessionActivityCapacity);
        }
        validate_instance(&input)?;
        let state_exists = self.with_inner(|inner| {
            inner.states.get(&input.id).is_some_and(|state| {
                state.config.login_revision == input.login_revision
                    && self.cache_revision(&state.config) == self.cache_revision(&input)
            })
        });
        if !state_exists {
            return Err(CatalogError::SessionGenerationChanged);
        }
        let rows = ace_models::acp::normalize_acp(metadata, &input)
            .map_err(|_| CatalogError::InvalidInstance)?;
        let profile = input
            .acp_agent_id
            .as_deref()
            .and_then(|id| id.strip_prefix("official:"))
            .map(|agent| agent.to_owned());
        let permission_modes =
            crate::modes::acp_permission_modes(metadata, input.provider, profile.as_deref());
        let revision = self.revision(&input);
        let identity = identity_revision(&input);
        let refreshed_at = self.now();
        self.with_inner(|inner| inner.session_writes += 1);
        let release = self.hold_writes(&input.id).await;
        let result = self
            .commit_session_write(
                &input,
                rows,
                permission_modes,
                revision,
                identity,
                refreshed_at,
            )
            .await;
        drop(release);
        self.with_inner(|inner| inner.session_writes = inner.session_writes.saturating_sub(1));
        result
    }

    async fn commit_session_write(
        &self,
        input: &ModelInstance,
        rows: Vec<ace_protocol::generated::CatalogModel>,
        permission_modes: Vec<Value>,
        revision: String,
        identity: String,
        refreshed_at: f64,
    ) -> Result<(), CatalogError> {
        if self.with_inner(|inner| !inner.states.contains_key(&input.id)) {
            return Err(CatalogError::SessionGenerationChanged);
        }
        let pending = self.with_inner(|inner| inner.deletions.has(&input.id));
        if pending {
            self.with_inner(|inner| inner.deletions.remove(&input.id))?;
        }
        if self.with_inner(|inner| !inner.states.contains_key(&input.id)) {
            return Err(CatalogError::SessionGenerationChanged);
        }
        let (models, previous) = self.with_inner(|inner| {
            let state = inner.states.get(&input.id);
            (
                crate::learned::keep_learned_options(
                    rows,
                    state
                        .and_then(|state| state.entry.as_ref())
                        .map(|entry| entry.models.as_slice()),
                ),
                state.and_then(|state| state.entry.clone()),
            )
        });
        let combined = crate::sources::refreshed_sources(
            crate::cleanup::clean_catalog(&models)
                .into_iter()
                .map(Arc::new)
                .collect(),
            None,
            previous.as_deref(),
            refreshed_at,
        );
        let entry = CacheEntry {
            provider: input.provider,
            instance: input.id.clone(),
            login_revision: Some(input.login_revision.clone()),
            revision,
            refreshed_at,
            models: combined.models,
            sources: Some(combined.sources),
            permission_modes: Some(permission_modes),
            identity_revision: Some(identity),
            connection_revision: None,
        };
        let mut storage = self.storage.clone();
        storage.replace(&entry)?;
        let entry = Arc::new(entry);
        self.with_inner(|inner| {
            if let Some(state) = inner.states.get_mut(&input.id) {
                state.entry = Some(entry);
                state.dirty = false;
                state.error = None;
                state.error_detail = None;
                state.unconfigured_at = None;
                state.view = None;
            }
        });
        if let Some(config) = self.registered(&input.id) {
            self.notify_config(&config);
        }
        Ok(())
    }

    /// A session's reported modes survive a restart: written onto the cached entry.
    pub fn update_permission_modes(&self, instance: &str, modes: Vec<Value>) {
        if self.with_inner(|inner| inner.closed) {
            return;
        }
        let needs_write = self.with_inner(|inner| {
            let Some(state) = inner.states.get_mut(instance) else {
                return false;
            };
            state.permission_modes = Some(modes.clone());
            inner.write_tails.contains_key(instance) || state.entry.is_some()
        });
        if let Some(config) = self.registered(instance) {
            self.notify_config(&config);
        }
        if !needs_write || self.with_inner(|inner| inner.session_writes) >= 64 {
            return;
        }
        let catalog = self.clone();
        let instance = instance.to_owned();
        // An accepted write is visible to close before its task first runs.
        let gate = crate::signals::Gate::new();
        self.with_inner(|inner| inner.accepted_writes.push(gate.clone()));
        self.options.spawn.spawn(Box::pin(async move {
            struct Accepted(crate::signals::Gate, Catalog, crate::signals::Gate);
            impl Drop for Accepted {
                fn drop(&mut self) {
                    self.1.with_inner(|inner| {
                        inner.accepted_writes.retain(|gate| !gate.same(&self.0));
                    });
                    self.2.open();
                }
            }
            let _accepted = Accepted(gate.clone(), catalog.clone(), gate.clone());
            catalog.persist_permission_modes(&instance, modes).await;
        }));
    }

    async fn persist_permission_modes(&self, instance: &str, modes: Vec<Value>) {
        self.with_inner(|inner| inner.session_writes += 1);
        let release = self.hold_writes(instance).await;
        let current = self.with_inner(|inner| {
            inner
                .states
                .get(instance)
                .and_then(|state| state.entry.clone())
                .map(|entry| (entry, state_modes(inner, instance)))
        });
        if let Some((current, _)) = current
            && current.permission_modes.as_deref() != Some(modes.as_slice())
        {
            let mut next = (*current).clone();
            next.permission_modes = Some(modes);
            let mut storage = self.storage.clone();
            if storage.replace(&next).is_ok() {
                let next = Arc::new(next);
                self.with_inner(|inner| {
                    if let Some(state) = inner.states.get_mut(instance)
                        && state
                            .entry
                            .as_ref()
                            .is_some_and(|entry| Arc::ptr_eq(entry, &current))
                    {
                        state.entry = Some(next);
                    }
                });
            }
        }
        drop(release);
        self.with_inner(|inner| inner.session_writes = inner.session_writes.saturating_sub(1));
    }
}

fn state_modes(inner: &mut crate::catalog::Inner, instance: &str) -> Option<Vec<Value>> {
    inner
        .states
        .get(instance)
        .and_then(|state| state.permission_modes.clone())
}
