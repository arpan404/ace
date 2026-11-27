// SPDX-License-Identifier: Apache-2.0
//! The opener's proof: a home the TypeScript opener made has the same `sqlite_master` as one the
//! Rust opener makes, and the version and permission guards behave.

use std::sync::Arc;

use ace_store::{Connection, OpenOptions, Value as Cell, stmt_cache};

use super::{EngineError, open};
use crate::repository::testsupport::Shell;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SchemaRow {
    kind: String,
    name: String,
    table: String,
    sql: String,
}

fn temp_connection(name: &str) -> Arc<Connection> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "ace-engine-open-{}-{}-{}-{}.sqlite",
        std::process::id(),
        name,
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0)
    ));
    Connection::open(
        path.to_str().unwrap_or_default(),
        OpenOptions {
            read_only: false,
            timeout_ms: 1_000,
        },
    )
    .expect("a temp home")
}

fn fixture() -> (Vec<SchemaRow>, Vec<SchemaRow>) {
    let value = ace_json::parse(include_str!("../../tests/fixtures/engine-schema.json"))
        .expect("the fixture is JSON");
    let rows = |key: &str| -> Vec<SchemaRow> {
        value
            .get(key)
            .and_then(ace_json::Value::as_array)
            .expect("a fixture half")
            .iter()
            .map(|row| SchemaRow {
                kind: text(row, "type"),
                name: text(row, "name"),
                table: text(row, "tbl_name"),
                sql: text(row, "sql"),
            })
            .collect()
    };
    (rows("base"), rows("opened"))
}

/// Every base table the engine's DDL references, rebuilt on an empty connection. The search
/// tables are FTS5 virtual tables whose shadow rows SQLite creates itself; nothing the opener
/// touches reads them.
fn seed_base(conn: &Arc<Connection>, base: &[SchemaRow]) {
    for row in base {
        if row.name.starts_with("search_") {
            continue;
        }
        conn.exec(&row.sql).expect("a base statement");
    }
}

fn engine_objects(rows: &[SchemaRow], base: &[SchemaRow]) -> Vec<SchemaRow> {
    let base_names: std::collections::HashSet<&str> =
        base.iter().map(|row| row.name.as_str()).collect();
    rows.iter()
        .filter(|row| !base_names.contains(row.name.as_str()))
        .cloned()
        .collect()
}

fn text(value: &ace_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(ace_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn schema(conn: &Arc<Connection>) -> Vec<SchemaRow> {
    stmt_cache::all_rows(
        conn,
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY rowid",
        vec![],
    )
    .expect("sqlite_master")
    .iter()
    .map(|row| SchemaRow {
        kind: cell(row.get("type")),
        name: cell(row.get("name")),
        table: cell(row.get("tbl_name")),
        sql: cell(row.get("sql")),
    })
    .collect()
}

fn cell(value: Option<&Cell>) -> String {
    match value {
        Some(Cell::Text(text)) => text.clone(),
        _ => String::new(),
    }
}

#[test]
fn the_rust_opener_leaves_the_same_sqlite_master_as_the_typescript_opener() {
    let (base, opened) = fixture();
    let conn = temp_connection("schema");
    seed_base(&conn, &base);
    let store = Shell::store(&conn);
    open(&store).expect("the opener");
    let actual = engine_objects(&schema(&conn), &base);
    let opened = engine_objects(&opened, &base);
    let names = |rows: &[SchemaRow]| {
        rows.iter()
            .map(|row| (row.kind.clone(), row.name.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&actual),
        names(&opened),
        "schema objects, in creation order"
    );
    // Every object's text is the TypeScript's byte for byte, not only its name.
    for (produced, expected) in actual.iter().zip(opened.iter()) {
        assert_eq!(produced, expected, "{} {}", expected.kind, expected.name);
    }
}

#[test]
fn an_opener_from_a_newer_or_older_build_is_refused_with_the_typescripts_message() {
    let (base, _) = fixture();
    let conn = temp_connection("version");
    seed_base(&conn, &base);
    conn.exec(
        "CREATE TABLE engine_schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
         INSERT INTO engine_schema_version VALUES (1, 8);",
    )
    .expect("a version row");
    let store = Shell::store(&conn);
    match open(&store) {
        Err(EngineError::Incompatible { message, recovery }) => {
            assert_eq!(message, "Unsupported engine schema version: expected 9");
            assert_eq!(recovery, super::RECOVERY);
        }
        other => panic!("expected an incompatible home, got {other:?}"),
    }
}

#[test]
fn a_pre_release_table_without_a_version_row_is_refused_instead_of_upgraded() {
    let (base, _) = fixture();
    let conn = temp_connection("legacy");
    seed_base(&conn, &base);
    conn.exec("CREATE TABLE engine_slots (thread_id TEXT PRIMARY KEY)")
        .expect("a legacy table");
    let store = Shell::store(&conn);
    assert!(matches!(
        open(&store),
        Err(EngineError::Incompatible { message, .. })
            if message == "Unsupported engine schema version: expected 9"
    ));
}

#[test]
fn the_opener_maps_a_stored_native_permission_to_its_ace_mode() {
    let (base, _) = fixture();
    let conn = temp_connection("permissions");
    seed_base(&conn, &base);
    let store = Shell::store(&conn);
    open(&store).expect("the opener");
    conn.exec(
        "INSERT INTO workspaces VALUES ('w','/tmp','Workspace',0);
         INSERT INTO threads (id,workspace_id,title,provider,status,created_at,updated_at)
           VALUES ('t','w','Thread','claude','{\"state\":\"new\"}',0,5);
         INSERT INTO engine_permissions VALUES ('t','acceptEdits','acceptEdits',NULL,NULL,NULL,NULL);",
    )
    .expect("a stored pre-ace selection");
    open(&store).expect("the second open");
    let row = stmt_cache::get_row(
        &conn,
        "SELECT override,effective FROM engine_permissions WHERE thread_id='t'",
        vec![],
    )
    .expect("the row")
    .expect("the permission");
    assert_eq!(cell(row.get("override")), "auto-review");
    assert_eq!(cell(row.get("effective")), "auto-review");
}
