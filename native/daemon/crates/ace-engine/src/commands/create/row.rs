// SPDX-License-Identifier: Apache-2.0
//! The create's stored row and its details (`create-thread.ts:19`-`:70`): the thread JSON in
//! `Thread`'s schema order, the workspace join its details carry, and the selection stored beside
//! them.

use ace_json::{Map, Value};

use super::{NewThread, options, text};
use crate::commands::worktree::base_branch_label;
use crate::inputs::provisional_title::{UNTITLED_THREAD, provisional_title};
use crate::{Core, EngineError};

pub(super) fn selection_provider(selection: &Value) -> String {
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
pub(super) fn thread_json(new: &NewThread<'_>, permission: &Value) -> Value {
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

/// `...(machine ? { machine } : {})` (`handler.ts:320`): the paired machine the daemon was
/// given, as JSON. An unbound port means a local thread.
pub fn machine(core: &Core) -> Option<Value> {
    core.ports
        .machine()
        .ok()
        .and_then(|json| ace_json::parse(&json).ok())
}

/// The create's `details`: the workspace, the mode and the checkout, in `ThreadDetails` order.
pub fn details(
    store: &crate::EngineStore,
    p: &Value,
    cwd: &str,
    machine: Option<Value>,
) -> Result<Value, EngineError> {
    let workspace_id = text(p, "workspaceId").unwrap_or_default();
    let (path, name, kind) = workspace_row(store, workspace_id)
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
    if let Some(machine) = machine {
        out.insert("machine", machine);
    }
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

pub(super) fn selection_json(p: &Value, model: Option<&str>, instance: Option<&str>) -> Value {
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

/// The thread's silence threshold: the engine's configured default (`core.silence_ms()`), which
/// is `options.silenceMs` else five minutes (`silence.ts:56`). A workspace's override is E5.6's.
pub(super) fn silence_ms(core: &Core, _p: &Value) -> f64 {
    core.silence_ms()
}
