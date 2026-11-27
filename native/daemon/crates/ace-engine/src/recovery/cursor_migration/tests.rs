// SPDX-License-Identifier: Apache-2.0
//! The empty-Cursor migration over a real store: an unused CLI thread continues on the SDK, and a
//! thread with a record of its own is never touched.

use super::*;
use crate::repository::testsupport::{Shell, header, home};
use ace_store::Value as Cell;
use std::sync::Arc;

fn cursor_thread(conn: &Arc<ace_store::Connection>, id: &str, instance: Option<&str>) {
    conn.exec(&format!(
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at)
         VALUES ('{id}', 'workspace', 'Cursor', 'cursor', '{{\"state\":\"new\"}}', 0, 7)"
    ))
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO thread_state VALUES ('{id}', {}, 0)",
        crate::repository::testsupport::sql_text(&header(id))
    ))
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO engine_sessions (thread_id, cwd, instance_id) VALUES ('{id}', '/tmp', {})",
        instance.map_or("NULL".to_owned(), |instance| format!("'{instance}'"))
    ))
    .unwrap();
}

fn backend(conn: &Arc<ace_store::Connection>, id: &str) -> (Option<String>, Option<String>) {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT backend, instance_id FROM engine_sessions WHERE thread_id=?",
        vec![Cell::Text(id.to_owned())],
    )
    .unwrap()
    .unwrap();
    (
        row.get("backend")
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned),
        row.get("instance_id")
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned),
    )
}

#[test]
fn an_unused_cursor_cli_thread_continues_on_the_sdk_default_instance() {
    let conn = home("t", &header("t"));
    cursor_thread(&conn, "cli", Some("cursor-cli-default"));
    cursor_thread(&conn, "named", Some("other"));
    cursor_thread(&conn, "bare", None);
    let store = Shell::store(&conn);
    migrate_empty_cursor_threads(&store).unwrap();
    assert_eq!(
        backend(&conn, "cli"),
        (
            Some("cursor-sdk".to_owned()),
            Some("cursor-sdk-default".to_owned())
        )
    );
    assert_eq!(
        backend(&conn, "named"),
        (Some("cursor-sdk".to_owned()), Some("other".to_owned()))
    );
    assert_eq!(
        backend(&conn, "bare"),
        (
            Some("cursor-sdk".to_owned()),
            Some("cursor-sdk-default".to_owned())
        )
    );
}

#[test]
fn a_cursor_thread_with_work_of_its_own_keeps_its_binding() {
    let conn = home("t", &header("t"));
    cursor_thread(&conn, "ran", None);
    crate::restart::ensure_ledgers(&conn).unwrap();
    // A run, an item or a native session means the thread is not unused.
    conn.exec(
        r#"UPDATE thread_state SET state=json_set(state,'$.hasRun',1) WHERE thread_id='ran'"#,
    )
    .unwrap();
    let store = Shell::store(&conn);
    migrate_empty_cursor_threads(&store).unwrap();
    assert_eq!(backend(&conn, "ran"), (None, None));
    conn.exec(
        r#"UPDATE thread_state SET state=json_set(state,'$.hasRun',0) WHERE thread_id='ran'"#,
    )
    .unwrap();
    conn.exec("INSERT INTO items VALUES ('i', 'ran', 1, '{}')")
        .unwrap();
    migrate_empty_cursor_threads(&store).unwrap();
    assert_eq!(backend(&conn, "ran"), (None, None));
    conn.exec("DELETE FROM items WHERE thread_id='ran'")
        .unwrap();
    conn.exec("UPDATE engine_sessions SET native_session_id='native' WHERE thread_id='ran'")
        .unwrap();
    migrate_empty_cursor_threads(&store).unwrap();
    assert_eq!(backend(&conn, "ran"), (None, None));
}
