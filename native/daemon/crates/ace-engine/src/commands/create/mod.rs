// SPDX-License-Identifier: Apache-2.0
//! `create-thread.ts` and the receipt's create (`handler.ts:205`-`:375`, E5.4e): the thread a
//! `thread.create` or `thread.prepare` writes, and the row order it writes it in.
//!
//! The three synchronous ports the create reaches (`workspaceDirectory`, `portableHandoff`,
//! `linkCreatedThread`) are not bound yet, so the branches that need them (a prepared workspace,
//! a pull-request link, a handoff's context and synthetic input) fail `NotPorted` rather than
//! writing part of a thread. The local path below is the whole of an ordinary create.

use ace_json::{Map, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::access::storage;
use crate::commands::validation::CreationFacts;
use crate::commands::worktree::base_branch_label;
use crate::commands::{command_id, error, ok, payload, payload_type};
use crate::snapshot::Snapshot;
use crate::snapshot::touched::Touched;
use crate::{Core, EngineError, State};

mod facts;
mod row;

use row::{
    details, live, selection_json, selection_provider, silence_ms, thread_json, title, title_source,
};

/// What the receipt's context carries that the create reads.
#[derive(Debug, Default)]
pub struct Context {
    /// `context.preparedWorkspace` (E5.6's Git preparation).
    pub prepared: Option<Value>,
}

/// One create's inputs, as the receipt assembled them.
pub struct NewThread<'a> {
    pub id: &'a str,
    pub access: Option<&'a str>,
    pub workspace_id: &'a str,
    pub title: String,
    pub title_source: &'a str,
    pub selection: Value,
    pub cwd: &'a str,
    pub workspace_ready: bool,
    pub at: f64,
    pub silence_ms: f64,
    pub backend: Option<&'a str>,
    pub capabilities: Option<Value>,
    pub acp_identity: Option<&'a Value>,
    pub handoff: Option<Value>,
    pub details: Value,
    pub live: Value,
    /// `client.details.mode === "worktree" && !workspaceReady`: no checkout yet.
    pub unprepared: bool,
}

pub(super) fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `ExecutionOptions.parse(options ?? {})`: the payload's options, as the schema stores them.
pub fn options(payload: &Value) -> Value {
    payload
        .get("options")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// `createEngineThread` (`create-thread.ts`): permissions, the thread row, its state, its
/// session row, its queue row and its transition metadata, in that order.
pub fn create_engine_thread(
    core: &Core,
    state: &mut State,
    new: &NewThread<'_>,
) -> Result<(), EngineError> {
    let store = &core.store;
    storage::ensure(store, new.id, new.access)?;
    let permission = storage::state(store, new.id)?;
    let thread = thread_json(new, &permission.to_json());
    let root = ace_core::state::RootAgentInit {
        agent: "root".to_owned(),
        spawned_by: None,
        lineage: None,
        fidelity: "full".to_owned(),
        native: ace_core::item_model::NativeRef {
            provider: selection_provider(&new.selection),
            acp_agent_id: new
                .acp_identity
                .and_then(|identity| text(identity, "acpAgentId").map(str::to_owned)),
            installation_id: new
                .acp_identity
                .and_then(|identity| text(identity, "installationId").map(str::to_owned)),
            instance_id: new
                .acp_identity
                .and_then(|identity| text(identity, "instanceId").map(str::to_owned)),
            native_id: None,
            path: None,
            forked_from_native_id: None,
            aliases: None,
        },
        cwd: new.cwd.to_owned(),
        name: None,
        role: None,
        model: text(&new.selection, "model").map(str::to_owned),
        background: None,
        machine: None,
    };
    let config = ace_core::state::CoreConfig {
        provider: selection_provider(&new.selection),
        silence_ms: new.silence_ms,
        liveness: None,
    };
    let thread_state = ace_core::state::create_thread_state(new.id.to_owned(), Some(root), config)
        .map_err(|error| EngineError::Records(error.to_string()))?;
    let snapshot = Rc::new(RefCell::new(Snapshot::new(
        std::sync::Arc::clone(store.conn()),
        state.repo.budget(),
        thread_state,
        None,
    )?));
    let mut created = Map::new();
    created.insert("type", Value::from("thread.created"));
    created.insert("thread", thread);
    let payloads = Value::Array(vec![Value::Object(created)].into());
    state.save(
        store,
        new.id,
        &snapshot,
        &ace_json::to_string(&payloads),
        new.at,
        &Touched::default(),
    )?;
    let model = text(&new.selection, "model");
    let instance = text(&new.selection, "instanceId");
    let options = new.selection.get("options").cloned();
    if !new.unprepared {
        crate::sessions::metadata::create_session(
            store,
            new.id,
            new.cwd,
            model,
            new.backend,
            instance,
            options.as_ref(),
        )?;
    } else {
        crate::sessions::metadata::create_unprepared_session(
            store,
            new.id,
            new.cwd,
            model,
            new.backend,
            instance,
            options.as_ref(),
        )?;
    }
    crate::queue::store::ensure(store.conn(), new.id)?;
    let mut transition = Map::new();
    transition.insert("selection", new.selection.clone());
    transition.insert("context", Value::Array(Vec::new().into()));
    state.transition_set(store, new.id, &Value::Object(transition))?;
    state.transition_remember(store, new.id, &new.selection)?;
    Ok(())
}

pub fn create(
    core: &Core,
    state: &mut State,
    command: &Value,
    context: &Context,
) -> Result<Value, EngineError> {
    let id = command_id(command).to_owned();
    let p = payload(command);
    let kind = payload_type(command);
    if !state.commands.admissions.authorized(command, None) {
        return Ok(error(&id, "thread_creation_in_progress"));
    }
    // `validateCreation` runs first (`handler.ts:217`): every refusal it owns commits, and the
    // workspace path it canonicalises is the one the thread records.
    let workspace_id = text(p, "workspaceId").unwrap_or_default().to_owned();
    let workspace_path = state.workspace(&core.store, &workspace_id)?;
    let provider = text(p, "provider").unwrap_or_default().to_owned();
    let (valid, backend) = {
        let facts = facts::Facts::read(core, state, p, workspace_path)?;
        let valid = match crate::commands::validation::validate_creation(command, &facts) {
            Ok(valid) => valid,
            Err(code) => return Ok(error(&id, &code)),
        };
        facts.failure()?;
        (valid, facts.backend(&provider))
    };
    let cwd = valid.cwd.clone();
    if context.prepared.is_some() {
        return Err(EngineError::not_ported("a prepared workspace", "E5.4e"));
    }
    if p.get("pullRequest").is_some() {
        return Err(EngineError::not_ported("a pull request's link", "E5.4e"));
    }
    if p.get("handoffFrom").is_some() {
        return Err(EngineError::not_ported("a handoff's context", "E5.4e"));
    }
    let at = core.ports.now();
    let catalog = crate::models::select::PortCatalog(&*core.ports);
    let catalog = core
        .ports
        .has_models()
        .then_some(&catalog as &dyn crate::models::select::Catalog);
    // The model is chosen before the slot is taken (`handler.ts:232`, `:269`): a refused model
    // must not leave an `engine_slots` row behind.
    let model = match crate::models::select::select(
        catalog,
        &provider,
        text(p, "model"),
        valid.instance_id.as_deref(),
        valid.acp_identity.as_ref(),
    ) {
        Ok(model) => model,
        // The catalog refused an explicit model; `onModelUnavailable` has already been told.
        Err(EngineError::ModelUnavailable) => return Ok(error(&id, "model_unavailable")),
        Err(error) => return Err(error),
    };
    // `p.threadId ?? nextId()` (`handler.ts:244`): a client may let the daemon name the thread.
    let thread_id = text(p, "threadId")
        .map(str::to_owned)
        .unwrap_or_else(|| core.ports.thread_id());
    // A prepared thread runs nothing until it is sent work, which reserves a slot then.
    if kind != "thread.prepare" && !state.repo.reserve(&core.store, &thread_id)? {
        let freed =
            crate::release::reclaim::reclaim_idle_slot(core, state, &|_| false, &|_| false)?;
        match freed {
            Some(freed) => {
                state.repo.retiring.insert(freed);
                if !state.repo.reserve(&core.store, &thread_id)? {
                    return Ok(error(&id, "engine_capacity_exceeded"));
                }
            }
            None => return Ok(error(&id, "engine_capacity_exceeded")),
        }
    }
    let selection = selection_json(p, model.as_deref(), valid.instance_id.as_deref());
    let instance = text(&selection, "instanceId").map(str::to_owned);
    let details = details(core, state, p, &cwd)?;
    let live = live(p, model.as_deref(), instance.as_deref());
    let new = NewThread {
        id: &thread_id,
        access: text(p, "access").filter(|access| *access != "inherit"),
        workspace_id: text(p, "workspaceId").unwrap_or_default(),
        title: title(p),
        title_source: title_source(p),
        selection,
        cwd: &cwd,
        workspace_ready: false,
        at,
        silence_ms: silence_ms(core, p),
        backend: backend.as_deref(),
        capabilities: Some(valid.capabilities.clone()),
        acp_identity: valid.acp_identity.as_ref(),
        handoff: None,
        details,
        live,
        unprepared: text(p, "mode") == Some("worktree"),
    };
    create_engine_thread(core, state, &new)?;
    if kind == "thread.prepare" {
        state.repo.release_slot(&core.store, &thread_id)?;
        return Ok(ok(&id, Some(&thread_id)));
    }
    Ok(ok(&id, Some(&thread_id)))
}

#[cfg(test)]
mod tests;
