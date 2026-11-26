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
use crate::inputs::provisional_title::{UNTITLED_THREAD, provisional_title};
use crate::snapshot::Snapshot;
use crate::snapshot::touched::Touched;
use crate::{Core, EngineError, State};

mod facts;

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

fn selection_provider(selection: &Value) -> String {
    text(selection, "provider").unwrap_or_default().to_owned()
}

/// `repo.store.getWorkspace(id)`: its path, name and metadata kind (`workspace-store.ts:53`).
fn workspace_row(
    store: &crate::EngineStore,
    workspace: &str,
) -> Option<(String, String, Option<String>)> {
    const ROW: &str = "SELECT w.path AS path, w.name AS name, m.kind AS kind \
                       FROM workspaces w LEFT JOIN workspace_metadata m ON m.workspace_id=w.id \
                       WHERE w.id = ?";
    let row = ace_store::stmt_cache::get_row(
        store.conn(),
        ROW,
        vec![ace_store::Value::Text(workspace.to_owned())],
    )
    .ok()
    .flatten()?;
    let cell = |key: &str| {
        row.get(key)
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned)
    };
    Some((cell("path")?, cell("name")?, cell("kind")))
}

/// The stored thread row, in `Thread`'s schema order (`thread.ts:92`).
fn thread_json(new: &NewThread<'_>, permission: &Value) -> Value {
    let mut thread = Map::new();
    thread.insert("hasSentMessage", Value::Bool(false));
    thread.insert("details", new.details.clone());
    thread.insert("live", new.live.clone());
    thread.insert("id", Value::from(new.id));
    thread.insert("workspaceId", Value::from(new.workspace_id));
    thread.insert("title", Value::from(new.title.as_str()));
    thread.insert("titleSource", Value::from(new.title_source));
    thread.insert(
        "provider",
        Value::from(selection_provider(&new.selection).as_str()),
    );
    if let Some(backend) = new.backend {
        thread.insert("backend", Value::from(backend));
    }
    if let Some(capabilities) = &new.capabilities {
        thread.insert("capabilities", capabilities.clone());
    }
    thread.insert("permission", permission.clone());
    if let Some(handoff) = &new.handoff {
        thread.insert("handoff", handoff.clone());
    }
    if let Some(identity) = new.acp_identity {
        for key in ["acpAgentId", "installationId", "instanceId"] {
            if let Some(value) = identity.get(key) {
                thread.insert(key, value.clone());
            }
        }
    }
    let mut status = Map::new();
    status.insert("state", Value::from("new"));
    thread.insert("status", Value::Object(status));
    thread.insert("createdAt", Value::from(new.at));
    thread.insert("updatedAt", Value::from(new.at));
    // `Thread`'s last fields: the selection the thread runs on.
    thread.insert("execution", new.selection.clone());
    Value::Object(thread)
}

/// The create's `details`: the workspace, the mode and the checkout, in `ThreadDetails` order.
pub fn details(core: &Core, state: &mut State, p: &Value, cwd: &str) -> Result<Value, EngineError> {
    let workspace_id = text(p, "workspaceId").unwrap_or_default();
    let (path, name, kind) = workspace_row(&core.store, workspace_id)
        .unwrap_or_else(|| (cwd.to_owned(), workspace_id.to_owned(), None));
    let mut workspace = Map::new();
    workspace.insert("id", Value::from(workspace_id));
    workspace.insert("name", Value::from(name.as_str()));
    // `project.path ?? cwd` (`create-thread.ts:44`): the workspace's stored spelling, not the
    // canonical directory the session runs in.
    workspace.insert("path", Value::from(path.as_str()));
    if let Some(kind) = kind {
        workspace.insert("kind", Value::from(kind.as_str()));
    }
    let mode = text(p, "mode").unwrap_or("local");
    let mut out = Map::new();
    out.insert("workspace", Value::Object(workspace));
    out.insert("mode", Value::from(mode));
    // A worktree thread has no checkout until its workspace is prepared.
    if mode != "worktree" {
        out.insert("worktree", Value::from(cwd));
    }
    if let Some(base) = base_branch_label(p) {
        out.insert("baseBranch", Value::from(base.as_str()));
    }
    // `...(machine ? { machine } : {})` (`handler.ts:320`): the paired machine, when the daemon
    // was given one. The port answers JSON; an unbound port means a local thread.
    if let Ok(machine) = core.ports.machine()
        && let Ok(machine) = ace_json::parse(&machine)
    {
        out.insert("machine", machine);
    }
    let _ = state;
    Ok(Value::Object(out))
}

/// The create's `live` block, in `ThreadRunMetadata` order.
pub fn live(p: &Value, model: Option<&str>, instance: Option<&str>) -> Value {
    let mut out = Map::new();
    out.insert(
        "provider",
        Value::from(text(p, "provider").unwrap_or_default()),
    );
    if let Some(model) = model {
        out.insert("model", Value::from(model));
    }
    if let Some(instance) = instance {
        out.insert("account", Value::from(instance));
    }
    out.insert("options", options(p));
    out.insert("subagentCount", Value::from(0.0));
    out.insert("backgroundTaskCount", Value::from(0.0));
    Value::Object(out)
}

/// `p.title`, else `provisionalTitle(p.input)` for a create, else `New thread`.
pub fn title(p: &Value) -> String {
    if let Some(title) = text(p, "title") {
        return title.to_owned();
    }
    if text(p, "type") == Some("thread.create") {
        let input = p
            .get("input")
            .and_then(Value::as_array)
            .map(|parts| parts.as_slice())
            .unwrap_or(&[]);
        return provisional_title(input, UNTITLED_THREAD).to_string();
    }
    "New thread".to_owned()
}

/// The title's source: an agent's for a prepare that says so, the person's for an explicit
/// title, and provisional otherwise.
pub fn title_source(p: &Value) -> &'static str {
    if text(p, "type") == Some("thread.prepare") && text(p, "titleSource") == Some("agent") {
        return "agent";
    }
    if p.get("title").is_some() {
        return "person";
    }
    "provisional"
}

/// The receipt's create (`handler.ts:205`-`:375`). The context's prepared workspace, a pull
/// request and a handoff need the three synchronous ports E5.4e does not bind yet.
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
        silence_ms: silence_ms(state, p),
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

/// The thread's selection: provider, the payload's options, its account and the resolved model.
fn selection_json(p: &Value, model: Option<&str>, instance: Option<&str>) -> Value {
    let mut selection = Map::new();
    selection.insert(
        "provider",
        Value::from(text(p, "provider").unwrap_or_default()),
    );
    if let Some(model) = model {
        selection.insert("model", Value::from(model));
    }
    if let Some(instance) = instance {
        selection.insert("instanceId", Value::from(instance));
    }
    selection.insert("options", options(p));
    Value::Object(selection)
}

/// The thread's silence threshold. The engine's own default until the silence port (E5.6)
/// lands; a workspace's override is E5.6's read.
fn silence_ms(_state: &State, _p: &Value) -> f64 {
    30_000.0
}

#[cfg(test)]
mod tests;
