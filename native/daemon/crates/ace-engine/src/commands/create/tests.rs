// SPDX-License-Identifier: Apache-2.0
//! The cases the TypeScript's own tests pin, moved beside the code they cover.

use super::*;

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

#[test]
fn a_create_is_named_from_its_first_words_and_a_prepare_without_one_is_new() {
    let create = value(
        r#"{"payload":{"type":"thread.create","input":[{"type":"text","text":"Fix the queue hold"}]}}"#,
    );
    assert_eq!(title(payload(&create)), "Fix the queue hold");
    assert_eq!(title_source(payload(&create)), "provisional");
    let named = value(
        r#"{"payload":{"type":"thread.create","title":"Mine","input":[{"type":"text","text":"x"}]}}"#,
    );
    assert_eq!(title(payload(&named)), "Mine");
    assert_eq!(title_source(payload(&named)), "person");
    let prepare = value(r#"{"payload":{"type":"thread.prepare","input":[]}}"#);
    assert_eq!(title(payload(&prepare)), "New thread");
    let agent = value(r#"{"payload":{"type":"thread.prepare","titleSource":"agent"}}"#);
    assert_eq!(title_source(payload(&agent)), "agent");
}

#[test]
fn the_stored_thread_keeps_the_schemas_key_order() {
    let selection = value(r#"{"provider":"codex","model":"gpt-5","options":{}}"#);
    let new = NewThread {
        id: "t",
        access: None,
        workspace_id: "w",
        title: "Title".into(),
        title_source: "provisional",
        selection,
        cwd: "/tmp",
        workspace_ready: false,
        at: 5.0,
        silence_ms: 1_000.0,
        backend: Some("sdk"),
        capabilities: None,
        acp_identity: None,
        handoff: None,
        details: value(r#"{"mode":"local"}"#),
        live: value(r#"{"provider":"codex"}"#),
        unprepared: false,
    };
    let thread = thread_json(&new, &value(r#"{"pending":false}"#));
    let keys: Vec<String> = thread
        .as_object()
        .map(|map| map.keys().map(|key| key.as_str().to_owned()).collect())
        .unwrap_or_default();
    assert_eq!(
        keys,
        [
            "hasSentMessage",
            "details",
            "live",
            "id",
            "workspaceId",
            "title",
            "titleSource",
            "provider",
            "backend",
            "permission",
            "status",
            "createdAt",
            "updatedAt"
        ]
    );
    assert_eq!(
        thread
            .get("status")
            .and_then(|s| s.get("state"))
            .and_then(Value::as_str),
        Some("new")
    );
    assert_eq!(thread.get("createdAt").and_then(Value::as_f64), Some(5.0));
}

#[test]
fn a_local_thread_keeps_its_checkout_and_a_worktree_waits_for_one() {
    let local = value(r#"{"type":"thread.create","workspaceId":"w","mode":"local"}"#);
    let details = details_for(&local, "/tmp/work");
    assert_eq!(details.get("mode").and_then(Value::as_str), Some("local"));
    assert_eq!(
        details.get("worktree").and_then(Value::as_str),
        Some("/tmp/work")
    );
    let worktree = value(r#"{"type":"thread.create","workspaceId":"w","mode":"worktree"}"#);
    let details = details_for(&worktree, "/tmp/work");
    assert_eq!(details.get("worktree"), None);
    let base = value(
        r#"{"type":"thread.create","workspaceId":"w","base":{"ref":"main","remote":"origin"}}"#,
    );
    assert_eq!(
        details_for(&base, "/tmp/work")
            .get("baseBranch")
            .and_then(Value::as_str),
        Some("origin/main")
    );
}

/// `details` without an engine: the workspace name falls back to the id.
fn details_for(p: &Value, cwd: &str) -> Value {
    let workspace_id = text(p, "workspaceId").unwrap_or_default();
    let mut workspace = Map::new();
    workspace.insert("id", Value::from(workspace_id));
    workspace.insert("name", Value::from(workspace_id));
    workspace.insert("path", Value::from(cwd));
    let mode = text(p, "mode").unwrap_or("local");
    let mut out = Map::new();
    out.insert("workspace", Value::Object(workspace));
    out.insert("mode", Value::from(mode));
    if mode != "worktree" {
        out.insert("worktree", Value::from(cwd));
    }
    if let Some(base) = base_branch_label(p) {
        out.insert("baseBranch", Value::from(base.as_str()));
    }
    Value::Object(out)
}
