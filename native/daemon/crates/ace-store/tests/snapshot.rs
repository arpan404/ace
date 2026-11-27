#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Behavioural tests for T4 thread row decoding, thread snapshots, and entity paging over real
//! SQLite tables.

use std::sync::Arc;

use ace_json::Value;
use ace_projection::WHOLE_REQUEST_CHARS;
use ace_store::reads::entity_window::{
    ENTITY_PAGE_BYTES, EntityCollection, MAX_SAFE_INTEGER, PENDING_BASE, RESOLVED_BASE,
    read_entity_page, read_entity_page_with_largest,
};
use ace_store::reads::snapshot::{
    FULL_TAIL, SnapshotError, SnapshotTail, TailEntry, retained_tail, snapshot_thread,
    snapshot_wire_message,
};
use ace_store::reads::stored::{trusted_from, untrusted};
use ace_store::reads::thread_row::read_thread_row;
use ace_store::{Connection, OpenOptions, Value as SqlValue};

fn open_db() -> Arc<Connection> {
    let conn = Connection::open(
        ":memory:",
        OpenOptions {
            read_only: false,
            timeout_ms: 0,
        },
    )
    .expect("open memory sqlite");
    conn.exec(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE threads (
           id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
           provider TEXT NOT NULL, status JSON NOT NULL, created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, archived_at INTEGER, root_agent_id TEXT,
           imported JSON, acp JSON, transitions JSON, provider_metadata JSON, client JSON
         );
         CREATE TABLE thread_cold (
           thread_id TEXT PRIMARY KEY, details JSON, capabilities JSON
         );
         CREATE TABLE sidebar_thread_revisions (
           revision INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL UNIQUE
         );
         CREATE TABLE thread_row_trust (
           thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical INTEGER NOT NULL
         );
         CREATE TABLE events (
           seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
           at INTEGER NOT NULL, type TEXT NOT NULL, payload JSON NOT NULL
         );
         CREATE TABLE items (
           id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_seq INTEGER NOT NULL UNIQUE, item JSON NOT NULL
         );
         CREATE TABLE item_heads (
           id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_seq INTEGER NOT NULL UNIQUE,
           size INTEGER NOT NULL, item_type TEXT NOT NULL, text_prefix INTEGER NOT NULL DEFAULT 0,
           text_last_unit INTEGER NOT NULL DEFAULT -1, agent_id TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE item_text_chunks (
           item_id TEXT NOT NULL, seq INTEGER NOT NULL, field TEXT NOT NULL, append TEXT NOT NULL,
           PRIMARY KEY(item_id, seq)
         );
         CREATE TABLE item_previews (
           id TEXT PRIMARY KEY, item JSON NOT NULL, target INTEGER NOT NULL
         );
         CREATE TABLE item_text_streams (
           id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, item_id TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL
         );
         CREATE TABLE item_source_chunks (
           stream_id TEXT NOT NULL, offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id, offset)
         );
         CREATE TABLE view_entities (
           thread_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, value JSON NOT NULL,
           PRIMARY KEY(thread_id, collection, id)
         );
         CREATE TABLE view_entity_windows (
           thread_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
           created_seq INTEGER NOT NULL, active INTEGER NOT NULL,
           PRIMARY KEY(thread_id, collection, id)
         );",
    )
    .expect("create schema");
    conn
}

fn exec_params(conn: &Arc<Connection>, sql: &str, params: &[Option<SqlValue>]) {
    let stmt = conn.prepare(sql).expect("prepare");
    stmt.bind(params).expect("bind");
    while stmt.step().expect("step").is_some() {}
}

#[test]
fn thread_row_decoding_matches_schema_order_and_handles_legacy_untrusted_rows() {
    let conn = open_db();
    // Legacy untrusted cursor thread with embedded details in client, embedded capabilities in
    // provider_metadata, legacy delegate_task recommendation, and no cursor-sdk backend.
    exec_params(
        &conn,
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, root_agent_id, transitions, provider_metadata, client)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Some(SqlValue::Text("t1".into())),
            Some(SqlValue::Text("w1".into())),
            Some(SqlValue::Text("Cursor thread".into())),
            Some(SqlValue::Text("cursor".into())),
            Some(SqlValue::Text(r#"{"state":"idle","extra":123}"#.into())),
            Some(SqlValue::Integer(100)),
            Some(SqlValue::Integer(200)),
            Some(SqlValue::Text("a-root".into())),
            Some(SqlValue::Text(
                r#"{"switch":{"recommendation":"delegate_task","reason":"better fit","at":150,"unknownField":1}}"#.into(),
            )),
            Some(SqlValue::Text(
                r#"{"titleSource":"person","goal":"invalid-goal","capabilities":{"streaming":true}}"#.into(),
            )),
            Some(SqlValue::Text(
                r#"{"pinned":true,"details":{"summary":"legacy detail"},"unknownClient":9}"#.into(),
            )),
        ],
    );

    let thread = read_thread_row(&conn, "t1")
        .expect("decode row")
        .expect("thread exists");
    let obj = match &thread {
        Value::Object(map) => map,
        _ => panic!("expected object"),
    };

    // Unknown fields stripped on untrusted row.
    assert!(obj.get("unknownClient").is_none());
    assert_eq!(obj.get("pinned"), Some(&Value::Bool(true)));
    // Legacy details rescued from client; legacy capabilities rescued from provider_metadata.
    assert!(obj.get("details").is_some());
    assert!(obj.get("capabilities").is_some());
    // Invalid goal dropped on untrusted row.
    assert!(obj.get("goal").is_none());
    // Legacy delegate_task rewritten to delegate.
    assert_eq!(
        obj.get("switch").and_then(|s| s.get("recommendation")),
        Some(&Value::String("delegate".into()))
    );
    // Derived cursor CLI retired continuation present.
    assert_eq!(
        obj.get("continuation").and_then(|c| c.get("reason")),
        Some(&Value::String("cursor_cli_retired".into()))
    );
    // Schema key order: pinned (from ThreadClientFields) precedes id, status follows rootAgentId,
    // switch is last.
    let keys: Vec<&str> = obj.iter().map(|(k, _)| k.as_str()).collect();
    let idx = |name: &str| keys.iter().position(|k| *k == name).expect(name);
    assert!(idx("pinned") < idx("id"));
    assert!(idx("id") < idx("workspaceId"));
    assert!(idx("continuation") < idx("capabilities"));
    assert!(idx("rootAgentId") < idx("status"));
    assert!(idx("status") < idx("createdAt"));
    assert!(idx("updatedAt") < idx("switch"));

    // Missing thread returns None.
    assert_eq!(read_thread_row(&conn, "missing").expect("read"), None);
}

#[test]
fn retained_tail_preserves_root_lane_half_reserve_under_subagent_flood() {
    let mut entries = Vec::new();
    // 4 root items followed by 10 subagent items.
    for i in 1..=4_u64 {
        entries.push(TailEntry {
            id: format!("r{i}"),
            seq: Some(i),
            root: true,
        });
    }
    for i in 5..=14_u64 {
        entries.push(TailEntry {
            id: format!("s{i}"),
            seq: Some(i),
            root: false,
        });
    }

    let tail = retained_tail(&entries, 6);
    let kept_ids: Vec<&str> = tail.kept.iter().map(|e| e.id.as_str()).collect();
    // Reserve = 6 / 2 = 3 root items (r2, r3, r4) + 3 newest subagent items (s12, s13, s14).
    assert_eq!(kept_ids, vec!["r2", "r3", "r4", "s12", "s13", "s14"]);
    // Newest evicted is s11 (index 10), so boundary is s12 (seq 12).
    assert_eq!(tail.before, Some(12));
}

#[test]
fn snapshot_thread_folds_chunks_retains_ancestors_orders_view_and_summarizes_wire() {
    let conn = open_db();
    exec_params(
        &conn,
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, root_agent_id)
         VALUES ('t1', 'w1', 'Snapshot test', 'claude', '{\"state\":\"working\"}', 1000, 2000, 'a-root')",
        &[],
    );
    exec_params(
        &conn,
        "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (42, 'e42', 't1', 2000, 'thread.updated', '{}')",
        &[],
    );

    // Agents: active root, inactive parent (not in active window, referenced by child), active child.
    let root_agent = r#"{"id":"a-root","threadId":"t1","origin":"root","parentId":null,"name":"root","status":{"state":"working"},"createdAt":1000,"updatedAt":2000}"#;
    let mid_agent = r#"{"id":"a-mid","threadId":"t1","origin":"subagent","parentId":"a-root","name":"mid","status":{"state":"idle"},"createdAt":1100,"updatedAt":1200}"#;
    let leaf_agent = r#"{"id":"a-leaf","threadId":"t1","origin":"subagent","parentId":"a-mid","name":"leaf","status":{"state":"idle"},"createdAt":1300,"updatedAt":1400}"#;
    for (seq, active, id, json) in [
        (1, 1, "a-root", root_agent),
        (2, 0, "a-mid", mid_agent),
        (3, 0, "a-leaf", leaf_agent),
    ] {
        exec_params(
            &conn,
            "INSERT INTO view_entities (thread_id, collection, id, value) VALUES ('t1', 'agents', ?, ?)",
            &[
                Some(SqlValue::Text(id.into())),
                Some(SqlValue::Text(json.into())),
            ],
        );
        // Put only a-root in view_entity_windows so a-leaf and a-mid must be pulled in via
        // item reference -> parentId walk.
        if active == 1 {
            exec_params(
                &conn,
                "INSERT INTO view_entity_windows (thread_id, collection, id, created_seq, active) VALUES ('t1', 'agents', ?, ?, 1)",
                &[
                    Some(SqlValue::Text(id.into())),
                    Some(SqlValue::Integer(seq)),
                ],
            );
        }
    }

    // Pending interaction with an oversized request (> WHOLE_REQUEST_CHARS) to test wire summary.
    let huge_text = "x".repeat(WHOLE_REQUEST_CHARS + 500);
    let interaction_json = format!(
        r#"{{"id":"int-1","threadId":"t1","agentId":"a-root","state":"pending","createdAt":1500,"request":{{"kind":"question","questions":[{{"id":"q1","prompt":"{huge_text}","options":[]}}]}}}}"#
    );
    exec_params(
        &conn,
        "INSERT INTO view_entities (thread_id, collection, id, value) VALUES ('t1', 'interactions', 'int-1', ?)",
        &[Some(SqlValue::Text(interaction_json))],
    );
    exec_params(
        &conn,
        "INSERT INTO view_entity_windows (thread_id, collection, id, created_seq, active) VALUES ('t1', 'interactions', 'int-1', 10, 1)",
        &[],
    );

    // Queue entity.
    exec_params(
        &conn,
        "INSERT INTO view_entities (thread_id, collection, id, value) VALUES ('t1', 'queue', 'thread', '{\"paused\":false,\"revision\":1,\"pendingCount\":0,\"entries\":[]}')",
        &[],
    );

    // Streaming message item by a-leaf with unmerged item_text_chunks.
    let msg_json = r#"{"id":"m1","threadId":"t1","agentId":"a-leaf","type":"message","role":"assistant","parts":[{"type":"text","text":"hello "}],"complete":false,"createdAt":1600,"raw":[]}"#;
    exec_params(
        &conn,
        "INSERT INTO items (id, thread_id, created_seq, item) VALUES ('m1', 't1', 20, ?)",
        &[Some(SqlValue::Text(msg_json.into()))],
    );
    exec_params(
        &conn,
        "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, agent_id) VALUES ('m1', 't1', 20, ?, 'message', 'a-leaf')",
        &[Some(SqlValue::Integer(msg_json.len() as i64))],
    );
    exec_params(
        &conn,
        "INSERT INTO item_text_chunks (item_id, seq, field, append) VALUES ('m1', 21, 'text', '\"world\"'), ('m1', 22, 'text', '\"!\"')",
        &[],
    );

    let view = snapshot_thread(conn.clone(), "t1", FULL_TAIL, &trusted_from(0), true)
        .expect("snapshot thread");
    let obj = match &view {
        Value::Object(m) => m,
        _ => panic!("expected object"),
    };

    // Exact createThreadView top-level key order.
    let keys: Vec<&str> = obj.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        &keys[..14],
        &[
            "kind",
            "seq",
            "thread",
            "agents",
            "agentChildren",
            "runs",
            "items",
            "itemOrder",
            "itemsBefore",
            "interactions",
            "backgroundTasks",
            "usage",
            "contextMeters",
            "usageSnapshots",
        ]
    );
    assert_eq!(obj.get("seq"), Some(&Value::Number(42_u64.into())));
    assert!(obj.get("queue").is_some());
    assert!(obj.get("partial").is_none());

    // Unmerged chunks were folded onto m1.
    let m1_text = obj
        .get("items")
        .and_then(|i| i.get("m1"))
        .and_then(|m| m.get("parts"))
        .and_then(|p| match p {
            Value::Array(arr) => arr.first(),
            _ => None,
        })
        .and_then(|p| p.get("text"));
    assert_eq!(m1_text, Some(&Value::String("hello world!".into())));

    // Retained agents include a-leaf (from m1) and a-mid (ancestor of a-leaf), and agentChildren
    // is rebuilt.
    let agents = obj.get("agents").expect("agents");
    assert!(agents.get("a-root").is_some());
    assert!(agents.get("a-mid").is_some());
    assert!(agents.get("a-leaf").is_some());
    let children = obj.get("agentChildren").expect("agentChildren");
    assert_eq!(
        children.get("a-root"),
        Some(&Value::Array(vec![Value::String("a-mid".into())].into()))
    );
    assert_eq!(
        children.get("a-mid"),
        Some(&Value::Array(vec![Value::String("a-leaf".into())].into()))
    );

    // Wire message wraps with bounded interaction summary.
    let wire = snapshot_wire_message(
        conn.clone(),
        "sub-1",
        "t1",
        FULL_TAIL,
        &trusted_from(0),
        true,
    )
    .expect("wire snapshot");
    assert_eq!(wire.get("type"), Some(&Value::String("snapshot".into())));
    assert_eq!(
        wire.get("subscriptionId"),
        Some(&Value::String("sub-1".into()))
    );
    assert_eq!(wire.get("seq"), Some(&Value::Number(42_u64.into())));
    let wire_int = wire
        .get("view")
        .and_then(|v| v.get("interactions"))
        .and_then(|i| i.get("int-1"))
        .expect("wire interaction");
    assert!(wire_int.get("truncated").is_some());

    // Unknown thread returns UnknownThread error.
    assert_eq!(
        snapshot_thread(conn, "no-such-thread", FULL_TAIL, &untrusted(), false),
        Err(SnapshotError::UnknownThread)
    );
}

#[test]
fn partial_tail_falls_back_to_bounded_preview_when_newest_item_exceeds_budget() {
    let conn = open_db();
    exec_params(
        &conn,
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at)
         VALUES ('t1', 'w1', 'Big item', 'claude', '{\"state\":\"idle\"}', 1000, 2000)",
        &[],
    );
    let big_text = "A".repeat(10_000);
    let msg_json = format!(
        r#"{{"id":"m-big","threadId":"t1","type":"message","role":"assistant","parts":[{{"type":"text","text":"{big_text}"}}],"complete":true,"createdAt":1600,"raw":[]}}"#
    );
    let preview_json = r#"{"id":"m-big","threadId":"t1","type":"message","role":"assistant","parts":[{"type":"text","text":"","source":{"streamId":"s1","bytes":20000}}],"complete":true,"createdAt":1600,"raw":[]}"#;
    exec_params(
        &conn,
        "INSERT INTO items (id, thread_id, created_seq, item) VALUES ('m-big', 't1', 5, ?)",
        &[Some(SqlValue::Text(msg_json.clone()))],
    );
    exec_params(
        &conn,
        "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, agent_id) VALUES ('m-big', 't1', 5, ?, 'message', '')",
        &[Some(SqlValue::Integer(msg_json.len() as i64))],
    );
    exec_params(
        &conn,
        "INSERT INTO item_previews (id, item, target) VALUES ('m-big', ?, 0)",
        &[Some(SqlValue::Text(preview_json.into()))],
    );
    exec_params(
        &conn,
        "INSERT INTO item_text_streams (id, thread_id, item_id, part, size) VALUES ('s1', 't1', 'm-big', 0, 20000)",
        &[],
    );
    // Write UTF-16LE bytes for the first 100 chars into item_source_chunks.
    let utf16_bytes: Vec<u8> = "A"
        .repeat(100)
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    exec_params(
        &conn,
        "INSERT INTO item_source_chunks (stream_id, offset, bytes) VALUES ('s1', 0, ?)",
        &[Some(SqlValue::Blob(utf16_bytes))],
    );

    let view = snapshot_thread(
        conn,
        "t1",
        SnapshotTail {
            items: 20,
            bytes: 2048,
        },
        &trusted_from(0),
        true,
    )
    .expect("partial snapshot");

    assert_eq!(
        view.get("partial").and_then(|p| p.get("previews")),
        Some(&Value::Array(vec![Value::String("m-big".into())].into()))
    );
    let shown = view
        .get("items")
        .and_then(|i| i.get("m-big"))
        .and_then(|m| m.get("parts"))
        .and_then(|p| match p {
            Value::Array(arr) => arr.first(),
            _ => None,
        })
        .and_then(|p| p.get("text"));
    assert_eq!(shown, Some(&Value::String("A".repeat(100).as_str().into())));
}

#[test]
fn entity_page_returns_active_before_inactive_with_versioned_cursors_and_too_large() {
    let conn = open_db();
    for (seq, active, id) in [(10, 0, "r1"), (20, 0, "r2"), (30, 1, "r3"), (40, 1, "r4")] {
        let json = format!(
            r#"{{"id":"{id}","threadId":"t1","agentId":"a1","trigger":"user","state":"{}","startedAt":{seq}}}"#,
            if active == 1 { "active" } else { "completed" }
        );
        exec_params(
            &conn,
            "INSERT INTO view_entities (thread_id, collection, id, value) VALUES ('t1', 'runs', ?, ?)",
            &[Some(SqlValue::Text(id.into())), Some(SqlValue::Text(json))],
        );
        exec_params(
            &conn,
            "INSERT INTO view_entity_windows (thread_id, collection, id, created_seq, active) VALUES ('t1', 'runs', ?, ?, ?)",
            &[
                Some(SqlValue::Text(id.into())),
                Some(SqlValue::Integer(seq)),
                Some(SqlValue::Integer(active)),
            ],
        );
    }

    // Page 1 (limit 1): gets newest active r4 (seq 40), cursor is PENDING_BASE + 40.
    let p1 = read_entity_page(
        &conn,
        "t1",
        EntityCollection::Runs,
        MAX_SAFE_INTEGER,
        1,
        ENTITY_PAGE_BYTES,
        99,
        true,
    )
    .expect("page 1");
    assert_eq!(
        p1.get("entitiesBefore"),
        Some(&Value::Number((PENDING_BASE + 40).into()))
    );
    assert_eq!(entry_ids(&p1), vec!["r4"]);

    // Page 2 (limit 1 from PENDING_BASE + 40): gets r3 (seq 30), then hits r2 (inactive),
    // so cursor transitions to PENDING_BASE (start of inactive).
    let p2 = read_entity_page(
        &conn,
        "t1",
        EntityCollection::Runs,
        PENDING_BASE + 40,
        1,
        ENTITY_PAGE_BYTES,
        99,
        true,
    )
    .expect("page 2");
    assert_eq!(
        p2.get("entitiesBefore"),
        Some(&Value::Number(PENDING_BASE.into()))
    );
    assert_eq!(entry_ids(&p2), vec!["r3"]);

    // Page 3 (limit 1 from PENDING_BASE): gets r2 (seq 20), cursor is RESOLVED_BASE + 20.
    let p3 = read_entity_page(
        &conn,
        "t1",
        EntityCollection::Runs,
        PENDING_BASE,
        1,
        ENTITY_PAGE_BYTES,
        99,
        true,
    )
    .expect("page 3");
    assert_eq!(
        p3.get("entitiesBefore"),
        Some(&Value::Number((RESOLVED_BASE + 20).into()))
    );
    assert_eq!(entry_ids(&p3), vec!["r2"]);

    // Page 4 (limit 1 from RESOLVED_BASE + 20): gets r1 (seq 10), cursor is null.
    let p4 = read_entity_page(
        &conn,
        "t1",
        EntityCollection::Runs,
        RESOLVED_BASE + 20,
        1,
        ENTITY_PAGE_BYTES,
        99,
        true,
    )
    .expect("page 4");
    assert_eq!(p4.get("entitiesBefore"), Some(&Value::Null));
    assert_eq!(entry_ids(&p4), vec!["r1"]);

    // Largest limit check: entities exceeding `largest` go into `tooLarge`, never dropped.
    let tl = read_entity_page_with_largest(
        &conn,
        "t1",
        EntityCollection::Runs,
        MAX_SAFE_INTEGER,
        10,
        ENTITY_PAGE_BYTES,
        10,
        99,
        true,
    )
    .expect("too large page");
    assert!(entry_ids(&tl).is_empty());
    let too_large = match tl.get("tooLarge") {
        Some(Value::Array(arr)) => arr,
        _ => panic!("expected tooLarge"),
    };
    assert_eq!(too_large.len(), 4);
}

fn entry_ids(page: &Value) -> Vec<String> {
    match page.get("entries") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|e| match e.get("id") {
                Some(Value::String(s)) => Some(s.as_str().to_owned()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}
