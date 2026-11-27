// SPDX-License-Identifier: Apache-2.0
//! Sidebar SQL facts, revisions, and materialized columns (`sidebar-facts.ts`,
//! `sidebar-revisions.ts`, `sidebar-columns.ts`).

use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::{Connection, Value as SqlValue};

/// Removed ids kept for the live sidebar; a reader further behind rebuilds instead.
pub const SIDEBAR_REMOVAL_LOG: usize = 4096;

/// Counted in project totals: not an unsent draft, nor a thread delegated from a paired machine.
pub const SIDEBAR_COUNTED: &str = "COALESCE(json_extract(client, '$.hasSentMessage'), 1) != 0 AND NOT (json_extract(client, '$.hasSentMessage') IS NULL AND json_extract(status, '$.state') = 'new' AND title = 'New thread') AND json_extract(transitions, '$.delegatedFrom') IS NULL";

const ATTENTION: &str = "COALESCE(json_extract(provider_metadata, '$.queue.paused'), 0) = 1 AND json_extract(provider_metadata, '$.queue.resumeAt') IS NULL AND json_extract(provider_metadata, '$.queue.reason') IS NOT NULL AND json_extract(provider_metadata, '$.queue.reason') NOT IN ('limit', 'snooze') AND NOT (json_extract(provider_metadata, '$.queue.reason') = 'manual' AND COALESCE(json_extract(provider_metadata, '$.queue.pendingCount'), 0) = 0)";

const FAILED_SINCE_SETTLED: &str = "json_extract(status, '$.state') = 'failed' AND json_extract(client, '$.activityAt') > json_extract(client, '$.settledAt') AND COALESCE(json_extract(client, '$.readAt'), 0) < json_extract(client, '$.activityAt')";

/// Paged with history below live threads; may be NULL (neither).
pub fn sidebar_settled_sql() -> String {
    let unsent = format!(
        "({ATTENTION}) AND json_extract(provider_metadata, '$.queue.reason') IN ('not_sent', 'uncertain') AND json_extract(client, '$.settledOverQueue') IS NOT json_extract(provider_metadata, '$.queue.revision')"
    );
    format!(
        "COALESCE(json_extract(client, '$.pinned'), 0) != 1 AND json_extract(client, '$.settledAt') IS NOT NULL AND json_extract(status, '$.state') NOT IN ('working', 'needs_you') AND NOT COALESCE({FAILED_SINCE_SETTLED}, 0) AND (CASE WHEN COALESCE(json_extract(client, '$.settledReason'), '') = 'manual' THEN NOT COALESCE({unsent}, 0) ELSE NOT ({ATTENTION}) END)"
    )
}

/// Gone from every list: deleted, or a host thread the daemon holds for itself (ADR 0121).
pub const SIDEBAR_DELETED: &str =
    "(json_extract(client, '$.deletedAt') IS NOT NULL OR json_extract(client, '$.host') IS NOT NULL)";

pub const SIDEBAR_ACTIVITY: &str = "COALESCE(json_extract(client, '$.activityAt'), updated_at)";

/// Whether the fact expressions can be evaluated on this row without json_extract failing.
pub const SIDEBAR_READABLE: &str = "(json_valid(client) IS NOT 0 AND json_valid(status) IS NOT 0 AND json_valid(provider_metadata) IS NOT 0 AND json_valid(transitions) IS NOT 0 AND typeof(client) != 'blob' AND typeof(status) != 'blob' AND typeof(provider_metadata) != 'blob' AND typeof(transitions) != 'blob')";

/// One thread's facts from its `threads` row, named as `sidebar_thread_columns` holds them.
pub fn sidebar_fact_columns_sql() -> String {
    let settled = sidebar_settled_sql();
    format!(
        "workspace_id AS workspace_id, ({SIDEBAR_DELETED}) AS deleted, archived_at IS NOT NULL AS archived, ({settled}) AS settled, CASE WHEN ({SIDEBAR_COUNTED}) THEN 1 ELSE 0 END AS counted, {SIDEBAR_ACTIVITY} AS activity, archived_at AS archived_at"
    )
}

const COLUMNS_DDL: &str = "
  thread_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  readable INTEGER NOT NULL,
  workspace_id TEXT,
  deleted INTEGER,
  archived INTEGER,
  settled INTEGER,
  counted INTEGER,
  activity,
  archived_at INTEGER";

const INDEXES: &[(&str, &str, &str)] = &[
    (
        "paged",
        "(activity DESC, thread_id)",
        "deleted = 0 AND archived = 0 AND settled = 1",
    ),
    (
        "paged_project",
        "(workspace_id, activity DESC, thread_id)",
        "deleted = 0 AND archived = 0 AND settled = 1",
    ),
    (
        "active",
        "(workspace_id, activity DESC, thread_id)",
        "deleted = 0 AND archived = 0 AND settled = 0",
    ),
    (
        "archived",
        "(archived_at DESC, thread_id)",
        "deleted = 0 AND archived = 1",
    ),
    (
        "archived_project",
        "(workspace_id, archived_at DESC, thread_id)",
        "deleted = 0 AND archived = 1",
    ),
    (
        "counted",
        "(archived, workspace_id)",
        "deleted = 0 AND counted = 1",
    ),
    ("unreadable", "(thread_id)", "readable = 0"),
];

fn columns_shape_hash() -> String {
    let facts = sidebar_fact_columns_sql();
    let input = format!("{COLUMNS_DDL}\n{SIDEBAR_READABLE}\n{facts}");
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

fn computed_columns_sql(where_clause: &str) -> String {
    let facts = sidebar_fact_columns_sql();
    let row = format!("SELECT threads.*, ({SIDEBAR_READABLE}) AS readable FROM threads WHERE {where_clause}");
    format!(
        "SELECT threads.id, revisions.revision, 1, {facts} FROM ({row}) AS threads JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE threads.readable \
         UNION ALL SELECT threads.id, revisions.revision, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM ({row}) AS threads JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE NOT threads.readable"
    )
}

/// Create `sidebar_thread_revisions`, `sidebar_thread_deletes`, `sidebar_epoch`,
/// `sidebar_thread_removals` and their triggers (`migrateSidebarRevisions`).
pub fn open_sidebar_revisions(conn: &Arc<Connection>) -> crate::Result<()> {
    let kept = query_count(
        conn,
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('sidebar_thread_insert', 'sidebar_thread_update', 'sidebar_thread_rekey', 'sidebar_thread_delete')",
    )?;
    conn.exec(
        "CREATE TABLE IF NOT EXISTS sidebar_thread_revisions (
           revision INTEGER PRIMARY KEY AUTOINCREMENT,
           thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS sidebar_thread_deletes (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           count INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO sidebar_thread_deletes(id, count) VALUES (1, 0);
         CREATE TABLE IF NOT EXISTS sidebar_epoch (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           token TEXT NOT NULL
         );
         INSERT OR IGNORE INTO sidebar_epoch(id, token) VALUES (1, lower(hex(randomblob(8))));
         CREATE TABLE IF NOT EXISTS sidebar_thread_removals (
           revision INTEGER PRIMARY KEY AUTOINCREMENT,
           thread_id TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sidebar_revisions_complete (id INTEGER PRIMARY KEY CHECK (id = 1));",
    )?;
    let reset = if kept < 4 {
        "DELETE FROM sidebar_revisions_complete;"
    } else {
        ""
    };
    in_savepoint(
        conn,
        "sidebar_revision_triggers",
        &format!(
            "{reset}
            DROP TRIGGER IF EXISTS sidebar_thread_insert;
            DROP TRIGGER IF EXISTS sidebar_thread_update;
            DROP TRIGGER IF EXISTS sidebar_thread_rekey;
            DROP TRIGGER IF EXISTS sidebar_thread_delete;
            CREATE TRIGGER sidebar_thread_insert AFTER INSERT ON threads BEGIN
              DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.id;
              INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
            END;
            CREATE TRIGGER sidebar_thread_update AFTER UPDATE ON threads BEGIN
              DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.id;
              INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
            END;
            CREATE TRIGGER sidebar_thread_rekey AFTER UPDATE OF id ON threads
            WHEN OLD.id IS NOT NEW.id BEGIN
              DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.id;
              UPDATE sidebar_thread_deletes SET count = count + 1 WHERE id = 1;
              INSERT INTO sidebar_thread_removals(thread_id) VALUES (OLD.id);
              DELETE FROM sidebar_thread_removals
                WHERE revision <= (SELECT MAX(revision) FROM sidebar_thread_removals) - {SIDEBAR_REMOVAL_LOG};
            END;
            CREATE TRIGGER sidebar_thread_delete AFTER DELETE ON threads BEGIN
              DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.id;
              UPDATE sidebar_thread_deletes SET count = count + 1 WHERE id = 1;
              INSERT INTO sidebar_thread_removals(thread_id) VALUES (OLD.id);
              DELETE FROM sidebar_thread_removals
                WHERE revision <= (SELECT MAX(revision) FROM sidebar_thread_removals) - {SIDEBAR_REMOVAL_LOG};
            END;"
        ),
    )?;
    if query_exists(conn, "SELECT 1 FROM sidebar_revisions_complete LIMIT 1")? {
        return Ok(());
    }
    in_savepoint(
        conn,
        "sidebar_revisions_complete",
        "DELETE FROM sidebar_thread_revisions WHERE thread_id NOT IN (SELECT id FROM threads);
         INSERT OR IGNORE INTO sidebar_thread_revisions(thread_id) SELECT id FROM threads;
         INSERT INTO sidebar_revisions_complete VALUES (1);",
    )
}

/// Create `sidebar_thread_columns`, its partial indexes, triggers, and run repair only when
/// needed (`openSidebarColumns`, ADR 0170).
pub fn open_sidebar_columns(conn: &Arc<Connection>) -> crate::Result<()> {
    conn.exec(&format!(
        "CREATE TABLE IF NOT EXISTS main.sidebar_thread_columns ({COLUMNS_DDL});
         CREATE TABLE IF NOT EXISTS main.sidebar_columns_shape (
           id INTEGER PRIMARY KEY CHECK (id = 1), shape TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS main.sidebar_columns_complete (id INTEGER PRIMARY KEY CHECK (id = 1));"
    ))?;
    for &(name, on, where_clause) in INDEXES {
        conn.exec(&format!(
            "CREATE INDEX IF NOT EXISTS main.sidebar_columns_{name} ON sidebar_thread_columns{on} WHERE {where_clause}"
        ))?;
    }
    let kept = query_count(
        conn,
        "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'trigger' AND name IN ('sidebar_columns_insert', 'sidebar_columns_delete')",
    )?;
    let recorded = query_text(conn, "SELECT shape FROM main.sidebar_columns_shape WHERE id = 1")?;
    let shape = columns_shape_hash();
    let clear_marker = if kept < 2 || recorded.as_deref() != Some(shape.as_str()) {
        "DELETE FROM main.sidebar_columns_complete;"
    } else {
        ""
    };
    let reset_shape = if recorded.as_deref() != Some(shape.as_str()) {
        format!(
            "DELETE FROM main.sidebar_thread_columns; INSERT INTO main.sidebar_columns_shape VALUES (1, '{shape}') ON CONFLICT(id) DO UPDATE SET shape = excluded.shape;"
        )
    } else {
        String::new()
    };
    let computed_new = computed_columns_sql("id = NEW.thread_id");
    in_savepoint(
        conn,
        "sidebar_columns_triggers",
        &format!(
            "{clear_marker}
            {reset_shape}
            DROP TRIGGER IF EXISTS main.sidebar_columns_insert;
            DROP TRIGGER IF EXISTS main.sidebar_columns_delete;
            CREATE TRIGGER main.sidebar_columns_insert AFTER INSERT ON sidebar_thread_revisions BEGIN
              DELETE FROM sidebar_thread_columns WHERE thread_id = NEW.thread_id;
              INSERT INTO sidebar_thread_columns {computed_new};
            END;
            CREATE TRIGGER main.sidebar_columns_delete AFTER DELETE ON sidebar_thread_revisions BEGIN
              DELETE FROM sidebar_thread_columns WHERE thread_id = OLD.thread_id;
            END;"
        ),
    )?;
    if query_exists(conn, "SELECT 1 FROM main.sidebar_columns_complete LIMIT 1")? {
        return Ok(());
    }
    let computed_missing =
        computed_columns_sql("id NOT IN (SELECT thread_id FROM sidebar_thread_columns)");
    in_savepoint(
        conn,
        "sidebar_columns_complete",
        &format!(
            "DELETE FROM sidebar_thread_columns WHERE NOT EXISTS (
               SELECT 1 FROM sidebar_thread_revisions AS revisions
               WHERE revisions.thread_id = sidebar_thread_columns.thread_id
                 AND revisions.revision = sidebar_thread_columns.revision
             );
             INSERT INTO sidebar_thread_columns {computed_missing};
             INSERT INTO main.sidebar_columns_complete VALUES (1);"
        ),
    )
}

/// PR #2737 rule 5: bump `sidebar_thread_revisions` for every thread of `workspace_id` when its
/// chat classification flips, writing no events and no thread columns.
pub fn bump_workspace_chat_revisions(
    conn: &Arc<Connection>,
    workspace_id: &str,
) -> crate::Result<()> {
    let stmt = conn.prepare(
        "SELECT id FROM threads WHERE workspace_id = ?",
    )?;
    stmt.bind(&[Some(SqlValue::Text(workspace_id.to_owned()))])?;
    let mut ids = Vec::new();
    while let Some(row) = stmt.step()? {
        if let Some(SqlValue::Text(id)) = row.first() {
            ids.push(id.clone());
        }
    }
    for id in ids {
        let del = conn.prepare("DELETE FROM sidebar_thread_revisions WHERE thread_id = ?")?;
        del.bind(&[Some(SqlValue::Text(id.clone()))])?;
        while del.step()?.is_some() {}
        let ins = conn.prepare("INSERT INTO sidebar_thread_revisions(thread_id) VALUES (?)")?;
        ins.bind(&[Some(SqlValue::Text(id))])?;
        while ins.step()?.is_some() {}
    }
    Ok(())
}

/// Whether `sidebar_thread_columns` has no unreadable rows (`sidebarColumnsReadable`).
pub fn sidebar_columns_readable(conn: &Arc<Connection>) -> crate::Result<bool> {
    if !query_exists(
        conn,
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sidebar_thread_columns' LIMIT 1",
    )? {
        return Ok(false);
    }
    Ok(!query_exists(
        conn,
        "SELECT 1 FROM sidebar_thread_columns WHERE readable = 0 LIMIT 1",
    )?)
}

/// This database's sidebar epoch token (`sidebar_epoch.token`).
pub fn sidebar_epoch(conn: &Arc<Connection>) -> crate::Result<Option<String>> {
    query_text(conn, "SELECT token FROM sidebar_epoch WHERE id = 1")
}

fn in_savepoint(conn: &Arc<Connection>, name: &str, sql: &str) -> crate::Result<()> {
    conn.exec(&format!("SAVEPOINT {name}"))?;
    if let Err(err) = conn.exec(sql) {
        let _ = conn.exec(&format!("ROLLBACK TO {name}; RELEASE {name}"));
        return Err(err);
    }
    conn.exec(&format!("RELEASE {name}"))
}

fn query_count(conn: &Arc<Connection>, sql: &str) -> crate::Result<i64> {
    let stmt = conn.prepare(sql)?;
    let Some(row) = stmt.step()? else {
        return Ok(0);
    };
    Ok(match row.first() {
        Some(SqlValue::Integer(n)) => *n,
        Some(SqlValue::Real(n)) => *n as i64,
        _ => 0,
    })
}

fn query_exists(conn: &Arc<Connection>, sql: &str) -> crate::Result<bool> {
    let stmt = conn.prepare(sql)?;
    Ok(stmt.step()?.is_some())
}

fn query_text(conn: &Arc<Connection>, sql: &str) -> crate::Result<Option<String>> {
    let stmt = conn.prepare(sql)?;
    let Some(row) = stmt.step()? else {
        return Ok(None);
    };
    Ok(match row.first() {
        Some(SqlValue::Text(s)) => Some(s.clone()),
        _ => None,
    })
}
