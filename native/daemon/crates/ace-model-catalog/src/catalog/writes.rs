// SPDX-License-Identifier: Apache-2.0
//! Writes that come from a session (`catalog.ts` `updateFromSession`,
//! `updatePermissionModes`), queued in the instance's turn order.
//!
//! The actor computes what the write will store when it accepts it, takes the write's
//! place in the queue, and runs it when its place is front. A dropped caller only drops
//! its reply; the write still runs on what the write before it left.

use std::sync::Arc;

use ace_models::instance::ModelInstance;
use serde_json::Value;

use crate::cache::CacheEntry;
use crate::catalog::actor::Actor;
use crate::catalog::commands::{Command, Reply};
use crate::catalog::writes;
use crate::catalog::{CatalogError, PendingOp, identity_revision, owns, validate_instance};

/// One accepted session write, waiting for its place.
pub(crate) struct SessionWrite {
    pub(crate) input: ModelInstance,
    pub(crate) generation: u64,
    pub(crate) rows: Vec<ace_protocol::generated::CatalogModel>,
    pub(crate) permission_modes: Vec<Value>,
    pub(crate) revision: String,
    pub(crate) identity: String,
    pub(crate) refreshed_at: f64,
    pub(crate) reply: Reply<Result<(), CatalogError>>,
}

/// One accepted permission-mode write, waiting for its place.
pub(crate) struct PermissionWrite {
    pub(crate) instance: String,
    pub(crate) modes: Vec<Value>,
    pub(crate) generation: Option<u64>,
}

/// The entry one session write stores, from the rows the actor kept.
pub(crate) fn entry(
    write: &SessionWrite,
    rows: Vec<ace_protocol::generated::CatalogModel>,
    previous: Option<&Arc<CacheEntry>>,
) -> CacheEntry {
    let combined = crate::sources::refreshed_sources(
        crate::cleanup::clean_catalog(&rows)
            .into_iter()
            .map(Arc::new)
            .collect(),
        None,
        previous.map(|entry| entry.as_ref()),
        write.refreshed_at,
    );
    CacheEntry {
        provider: write.input.provider,
        instance: write.input.id.clone(),
        login_revision: Some(write.input.login_revision.clone()),
        revision: write.revision.clone(),
        refreshed_at: write.refreshed_at,
        models: combined.models,
        sources: Some(combined.sources),
        permission_modes: Some(write.permission_modes.clone()),
        identity_revision: Some(write.identity.clone()),
        connection_revision: None,
    }
}

impl Actor {
    /// Metadata from an already authorized session. No process or inference starts.
    pub(crate) fn update_session(
        &mut self,
        input: ModelInstance,
        metadata: &Value,
        reply: Reply<Result<(), CatalogError>>,
    ) {
        if self.inner.closed {
            let _ = reply.send(Err(CatalogError::Closed));
            return;
        }
        if self.inner.session_writes >= 64 {
            let _ = reply.send(Err(CatalogError::SessionActivityCapacity));
            return;
        }
        if let Err(error) = validate_instance(&input) {
            let _ = reply.send(Err(error));
            return;
        }
        let generation = self.inner.states.get(&input.id).and_then(|state| {
            (state.config.login_revision == input.login_revision
                && crate::catalog::cache_revision(&state.config)
                    == crate::catalog::cache_revision(&input))
            .then_some(state.generation)
        });
        let Some(generation) = generation else {
            let _ = reply.send(Err(CatalogError::SessionGenerationChanged));
            return;
        };
        let rows = match ace_models::acp::normalize_acp(metadata, &input) {
            Ok(rows) => rows,
            Err(_) => {
                let _ = reply.send(Err(CatalogError::InvalidInstance));
                return;
            }
        };
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
        self.inner.session_writes += 1;
        let write = SessionWrite {
            input,
            generation,
            rows,
            permission_modes,
            revision,
            identity,
            refreshed_at,
            reply,
        };
        let id = write.input.id.clone();
        self.inner
            .turns
            .entry(id.clone())
            .or_default()
            .accept(PendingOp::SessionWrite(Box::new(write)));
        self.pump(&id);
    }

    fn still_current(&self, input: &ModelInstance, generation: u64) -> bool {
        self.inner.states.get(&input.id).is_some_and(|state| {
            state.generation == generation
                && state.config.login_revision == input.login_revision
                && crate::catalog::cache_revision(&state.config)
                    == crate::catalog::cache_revision(input)
        })
    }

    pub(crate) fn execute_session_write(&mut self, write: SessionWrite) {
        let result = self.run_session_write(&write);
        self.inner.session_writes = self.inner.session_writes.saturating_sub(1);
        let _ = write.reply.send(result);
    }

    fn run_session_write(&mut self, write: &SessionWrite) -> Result<(), CatalogError> {
        if !self.still_current(&write.input, write.generation) {
            return Err(CatalogError::SessionGenerationChanged);
        }
        let pending = self.inner.deletions.has(&write.input.id);
        if pending {
            self.deletions_remove(&write.input.id)?;
        }
        if !self.still_current(&write.input, write.generation) {
            return Err(CatalogError::SessionGenerationChanged);
        }
        let previous = self
            .inner
            .states
            .get(&write.input.id)
            .and_then(|state| state.entry.clone());
        let models = crate::learned::keep_learned_options(
            write.rows.clone(),
            previous.as_ref().map(|entry| entry.models.as_slice()),
        );
        let entry = writes::entry(write, models, previous.as_ref());
        if !self.still_current(&write.input, write.generation) {
            return Err(CatalogError::SessionGenerationChanged);
        }
        self.storage_replace(&entry)?;
        let entry = Arc::new(entry);
        if let Some(state) = self.inner.states.get_mut(&write.input.id)
            && state.generation == write.generation
        {
            state.entry = Some(entry);
            state.dirty = false;
            state.error = None;
            state.error_detail = None;
            state.unconfigured_at = None;
            state.view = None;
        }
        self.notify_id(&write.input.id);
        Ok(())
    }

    /// A session's reported modes survive a restart: written onto the cached entry.
    pub(crate) fn update_modes(&mut self, instance: &str, modes: Vec<Value>) {
        if self.inner.closed {
            return;
        }
        let generation = self
            .inner
            .states
            .get(instance)
            .map(|state| state.generation);
        let needs_write = self.inner.states.get_mut(instance).is_some_and(|state| {
            state.permission_modes = Some(modes.clone());
            self.inner.turns.contains_key(instance) || state.entry.is_some()
        });
        self.notify_id(instance);
        if !needs_write {
            return;
        }
        if self.inner.session_writes >= 64 {
            return;
        }
        self.inner.session_writes += 1;
        let id = instance.to_owned();
        let place = self
            .inner
            .turns
            .entry(id.clone())
            .or_default()
            .accept_when_ready(PendingOp::PermissionWrite(Box::new(PermissionWrite {
                instance: id.clone(),
                modes,
                generation,
            })));
        // The write runs from its place, once its task reports; a task dropped before it
        // runs still lets the write (and close) settle.
        let reporter = self.reporter.clone();
        let task_id = id.clone();
        let task: futures::future::BoxFuture<'static, ()> = Box::pin(async move {
            reporter.report(Command::PermissionReady { id: task_id, place });
        });
        self.spawn(
            crate::catalog::actor::TaskKind::Permission { id, place },
            task,
        );
    }

    pub(crate) fn execute_permission_write(&mut self, write: PermissionWrite) {
        self.inner.session_writes = self.inner.session_writes.saturating_sub(1);
        let Some(generation) = write.generation else {
            return;
        };
        if !owns(&self.inner, &write.instance, generation) {
            return;
        }
        let current = self
            .inner
            .states
            .get(&write.instance)
            .and_then(|state| state.entry.clone());
        let Some(current) = current else {
            return;
        };
        if current.permission_modes.as_deref() == Some(write.modes.as_slice()) {
            return;
        }
        let mut next = (*current).clone();
        next.permission_modes = Some(write.modes);
        if self.storage_replace(&next).is_ok() {
            let next = Arc::new(next);
            if let Some(state) = self.inner.states.get_mut(&write.instance)
                && state
                    .entry
                    .as_ref()
                    .is_some_and(|entry| Arc::ptr_eq(entry, &current))
            {
                state.entry = Some(next);
            }
        }
    }
}
