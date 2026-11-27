// SPDX-License-Identifier: Apache-2.0
//! Incremental live sidebar index synchronized from SQLite (`sidebar-live.ts`).

use std::sync::Arc;

use crate::reads::sidebar::facts::{sidebar_columns_readable, sidebar_fact_columns_sql};
use crate::reads::sidebar::index::{SidebarFacts, SidebarIndex};
use crate::{Connection, Value as SqlValue};

const FROM_COLUMNS: &str = "SELECT sidebar.thread_id AS id, COALESCE(revisions.revision, 0) AS revision, sidebar.workspace_id AS workspace_id, sidebar.deleted AS deleted, sidebar.archived AS archived, sidebar.settled AS settled, sidebar.counted AS counted, sidebar.activity AS activity, sidebar.archived_at AS archived_at, EXISTS (SELECT 1 FROM workspace_metadata AS meta WHERE meta.workspace_id = sidebar.workspace_id AND meta.kind = 'chat') AS chat";

fn from_threads_select() -> String {
    let facts = sidebar_fact_columns_sql();
    format!(
        "SELECT threads.id AS id, COALESCE(revisions.revision, 0) AS revision, {facts}, EXISTS (SELECT 1 FROM workspace_metadata AS meta WHERE meta.workspace_id = threads.workspace_id AND meta.kind = 'chat') AS chat"
    )
}

/// Errors from syncing or reading the sidebar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidebarError {
    MalformedRow(&'static str),
    MembershipChanged,
    Store(String),
}

impl std::fmt::Display for SidebarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidebarError::MalformedRow(col) => write!(f, "malformed sidebar row: {col}"),
            SidebarError::MembershipChanged => write!(f, "Sidebar membership changed within a read"),
            SidebarError::Store(msg) => write!(f, "store error: {msg}"),
        }
    }
}

impl std::error::Error for SidebarError {}

impl From<crate::Error> for SidebarError {
    fn from(e: crate::Error) -> Self {
        SidebarError::Store(e.to_string())
    }
}

/// The sidebar index kept current from the database itself (`SidebarLive`).
///
/// Each `sync` reads only rows whose revision moved past `seen` and applies `sidebar_thread_removals`
/// since `removed`, rebuilding only on first sync or when the removal log can no longer account for
/// every counted delete.
#[derive(Debug, Default)]
pub struct SidebarLive {
    index: SidebarIndex,
    seen: Option<u64>,
    deletes: Option<i64>,
    removed: u64,
}

impl SidebarLive {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn index(&self) -> &SidebarIndex {
        &self.index
    }

    /// The newest row revision the index holds.
    pub fn revision(&self) -> u64 {
        self.seen.unwrap_or(0)
    }

    /// Forget everything; the next `sync` rebuilds from every row.
    pub fn reset(&mut self) {
        self.seen = None;
        self.deletes = None;
        self.removed = 0;
        self.index.clear();
    }

    /// Bring the index up to the snapshot currently visible on `conn`.
    pub fn sync(&mut self, conn: &Arc<Connection>) -> Result<(), SidebarError> {
        let deletes = read_delete_count(conn)?;
        if self.seen.is_none() || (deletes != self.deletes && !self.remove_deleted(conn, deletes)?)
        {
            self.rebuild(conn, deletes)?;
            return Ok(());
        }
        let seen = self.seen.unwrap_or(0);
        let sql = if sidebar_columns_readable(conn)? {
            format!(
                "{FROM_COLUMNS} FROM sidebar_thread_revisions AS revisions JOIN sidebar_thread_columns AS sidebar ON sidebar.thread_id = revisions.thread_id WHERE revisions.revision > ? ORDER BY revisions.revision"
            )
        } else {
            format!(
                "{} FROM sidebar_thread_revisions AS revisions JOIN threads ON threads.id = revisions.thread_id WHERE revisions.revision > ? ORDER BY revisions.revision",
                from_threads_select()
            )
        };
        let stmt = conn.prepare(&sql)?;
        stmt.bind(&[Some(SqlValue::Integer(seen as i64))])?;
        let mut next_seen = seen;
        while let Some(row) = stmt.step()? {
            let facts = decode_facts(&row)?;
            next_seen = next_seen.max(facts.revision);
            self.index.put(facts);
        }
        self.seen = Some(next_seen);
        Ok(())
    }

    fn remove_deleted(
        &mut self,
        conn: &Arc<Connection>,
        deletes: Option<i64>,
    ) -> Result<bool, SidebarError> {
        let (Some(next_deletes), Some(prev_deletes)) = (deletes, self.deletes) else {
            return Ok(false);
        };
        let expected = next_deletes - prev_deletes;
        if expected < 0 {
            return Ok(false);
        }
        let stmt = conn.prepare(
            "SELECT revision, thread_id FROM sidebar_thread_removals WHERE revision > ? ORDER BY revision",
        )?;
        stmt.bind(&[Some(SqlValue::Integer(self.removed as i64))])?;
        let mut removals = Vec::new();
        while let Some(row) = stmt.step()? {
            let rev = match row.first() {
                Some(SqlValue::Integer(n)) => *n as u64,
                _ => return Err(SidebarError::MalformedRow("removal.revision")),
            };
            let id = match row.get(1) {
                Some(SqlValue::Text(s)) => s.clone(),
                _ => return Err(SidebarError::MalformedRow("removal.thread_id")),
            };
            removals.push((rev, id));
        }
        if removals.len() as i64 != expected {
            return Ok(false);
        }
        for (rev, id) in removals {
            self.index.remove(&id);
            self.removed = rev;
        }
        self.deletes = deletes;
        Ok(true)
    }

    fn rebuild(
        &mut self,
        conn: &Arc<Connection>,
        deletes: Option<i64>,
    ) -> Result<(), SidebarError> {
        let sql = if sidebar_columns_readable(conn)? {
            format!(
                "{FROM_COLUMNS} FROM sidebar_thread_columns AS sidebar LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = sidebar.thread_id"
            )
        } else {
            format!(
                "{} FROM threads LEFT JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id",
                from_threads_select()
            )
        };
        let stmt = conn.prepare(&sql)?;
        let mut all = Vec::new();
        let mut seen = 0_u64;
        while let Some(row) = stmt.step()? {
            let facts = decode_facts(&row)?;
            seen = seen.max(facts.revision);
            all.push(facts);
        }
        self.index
            .load(all)
            .map_err(|msg| SidebarError::Store(msg.to_owned()))?;
        self.seen = Some(seen);
        self.deletes = deletes;
        self.removed = read_max_removal(conn)?;
        Ok(())
    }
}

fn read_delete_count(conn: &Arc<Connection>) -> Result<Option<i64>, SidebarError> {
    let stmt = conn.prepare("SELECT count FROM sidebar_thread_deletes WHERE id = 1")?;
    let Some(row) = stmt.step()? else {
        return Ok(None);
    };
    Ok(match row.first() {
        Some(SqlValue::Integer(n)) => Some(*n),
        Some(SqlValue::Real(n)) => Some(*n as i64),
        _ => None,
    })
}

fn read_max_removal(conn: &Arc<Connection>) -> Result<u64, SidebarError> {
    let stmt = conn.prepare("SELECT COALESCE(MAX(revision), 0) FROM sidebar_thread_removals")?;
    let Some(row) = stmt.step()? else {
        return Ok(0);
    };
    Ok(match row.first() {
        Some(SqlValue::Integer(n)) => (*n).max(0) as u64,
        Some(SqlValue::Real(n)) => (*n).max(0.0) as u64,
        _ => 0,
    })
}

fn decode_facts(row: &[SqlValue]) -> Result<SidebarFacts, SidebarError> {
    if row.len() < 10 {
        return Err(SidebarError::MalformedRow("facts_length"));
    }
    let id = match &row[0] {
        SqlValue::Text(s) => s.clone(),
        _ => return Err(SidebarError::MalformedRow("id")),
    };
    let revision = match &row[1] {
        SqlValue::Integer(n) => (*n).max(0) as u64,
        SqlValue::Real(n) => (*n).max(0.0) as u64,
        _ => 0,
    };
    let settled = match &row[5] {
        SqlValue::Integer(1) => Some(true),
        SqlValue::Integer(0) => Some(false),
        _ => None,
    };
    Ok(SidebarFacts {
        id,
        revision,
        workspace: row[2].clone(),
        deleted: matches!(row[3], SqlValue::Integer(1)),
        archived: matches!(row[4], SqlValue::Integer(1)),
        settled,
        counted: matches!(row[6], SqlValue::Integer(1)),
        activity: row[7].clone(),
        archived_at: row[8].clone(),
        chat: matches!(row[9], SqlValue::Integer(1)),
    })
}
