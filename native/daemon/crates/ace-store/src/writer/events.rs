// SPDX-License-Identifier: Apache-2.0
//! The event writer's own rows (task 5.3a): a new thread's row, its `workspace_recent`
//! entry, and one event row with the high-water mark that stores it. Ports the two
//! statement blocks of `apps/daemon/src/event-writer.ts`; the loop around them stays
//! TypeScript until 5.3c.
//!
//! The writer holds prepared statements and no thread or event state. JavaScript numbers
//! stay `f64` and bind as REAL, exactly as node:sqlite binds them; the payload and status
//! JSON are stored as the shell stringified them, never parsed and printed again.

use crate::sqlite::Statement;
use crate::{Connection, Value};
use std::fmt;
use std::sync::Arc;

/// `SELECT 1 FROM workspace_unregistered WHERE workspace_id=?`.
const WORKSPACE_UNREGISTERED: &str = "SELECT 1 FROM workspace_unregistered WHERE workspace_id=?";
/// The named-column form of the TypeScript insert (porting-guide phase 4 rule 3).
const INSERT_THREAD: &str = "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
/// Work starting in a project makes it the most recently used one there (ADR 0180).
const INSERT_RECENT: &str = "INSERT INTO workspace_recent VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET opened_at=max(opened_at,excluded.opened_at)";
/// The named-column form both writer modes use.
const INSERT_EVENT: &str =
    "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (?, ?, ?, ?, ?, ?)";
/// A stored row moves the mark in its own transaction (`event-writer.ts:182`).
const MOVE_MARK: &str = "UPDATE host_sequence SET seq = MAX(seq,?) WHERE id = 1";

/// Why a write failed. `WorkspaceUnregistered` displays the TypeError's message.
#[derive(Debug)]
pub enum WriteError {
    WorkspaceUnregistered,
    Sqlite(crate::Error),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::WorkspaceUnregistered => f.write_str("workspace_unregistered"),
            WriteError::Sqlite(error) => f.write_str(&error.message),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<crate::Error> for WriteError {
    fn from(error: crate::Error) -> Self {
        WriteError::Sqlite(error)
    }
}

/// A new thread's `threads` row, from the `thread.created` event the shell read.
pub struct NewThreadRow<'a> {
    pub id: &'a str,
    pub workspace_id: &'a str,
    pub title: &'a str,
    pub provider: &'a str,
    /// `JSON.stringify(thread.status)`.
    pub status_json: &'a str,
    pub created_at: f64,
    /// The append's `at`, which the TypeScript stores as the row's `updated_at`.
    pub updated_at: f64,
    /// `JSON.stringify(thread.imported)`, or None for NULL.
    pub imported_json: Option<&'a str>,
    /// `Boolean(thread.imported)`: an imported thread started nothing now.
    pub imported: bool,
}

/// One event row and the mark it moves.
pub struct EventRow<'a> {
    pub seq: f64,
    pub id: &'a str,
    pub thread_id: &'a str,
    /// The append's `at`, not `event.at`.
    pub at: f64,
    pub kind: &'a str,
    /// `JSON.stringify(event.payload)` after capping, stored as given.
    pub payload_json: &'a str,
}

/// The writer's cached statements, prepared on its connection.
pub struct EventWriter {
    workspace_unregistered: Statement,
    insert_thread: Statement,
    insert_recent: Statement,
    insert_event: Statement,
    move_mark: Statement,
}

/// Run one write to completion; a bound statement is reset by the next `bind`.
fn run(statement: &Statement, params: Vec<Value>) -> Result<(), crate::Error> {
    let bound: Vec<Option<Value>> = params.into_iter().map(Some).collect();
    statement.bind(&bound)?;
    while statement.step()?.is_some() {}
    Ok(())
}

/// Bind one text parameter; a NULL is spelled as an absent parameter only for `imported`.
fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

impl EventWriter {
    /// Prepare the writer's statements on `conn`. Runs after `migrate`, which creates the
    /// tables they name.
    pub fn new(conn: &Arc<Connection>) -> Result<EventWriter, crate::Error> {
        Ok(EventWriter {
            workspace_unregistered: conn.prepare(WORKSPACE_UNREGISTERED)?,
            insert_thread: conn.prepare(INSERT_THREAD)?,
            insert_recent: conn.prepare(INSERT_RECENT)?,
            insert_event: conn.prepare(INSERT_EVENT)?,
            move_mark: conn.prepare(MOVE_MARK)?,
        })
    }

    /// The `workspace_unregistered` check, `INSERT INTO threads`, and `workspace_recent`
    /// unless imported. The `Invalid thread creation` check stays in the TypeScript.
    pub fn create_thread(
        &mut self,
        conn: &Connection,
        row: &NewThreadRow,
    ) -> Result<(), WriteError> {
        // The statements hold their connection; `conn` names the same one the shell wrote on.
        let _ = conn;
        let existing =
            stmt_step(&self.workspace_unregistered, vec![text(row.workspace_id)])?.is_some();
        if existing {
            return Err(WriteError::WorkspaceUnregistered);
        }
        run(
            &self.insert_thread,
            vec![
                text(row.id),
                text(row.workspace_id),
                text(row.title),
                text(row.provider),
                text(row.status_json),
                Value::Real(row.created_at),
                Value::Real(row.updated_at),
                match row.imported_json {
                    Some(imported) => text(imported),
                    None => Value::Null,
                },
            ],
        )?;
        if !row.imported {
            run(
                &self.insert_recent,
                vec![text(row.workspace_id), Value::Real(row.updated_at)],
            )?;
        }
        Ok(())
    }

    /// `INSERT INTO events` then `UPDATE host_sequence SET seq = MAX(seq,?)`, in the
    /// caller's transaction.
    pub fn store_event(&mut self, conn: &Connection, row: &EventRow) -> Result<(), WriteError> {
        let _ = conn;
        run(
            &self.insert_event,
            vec![
                Value::Real(row.seq),
                text(row.id),
                text(row.thread_id),
                Value::Real(row.at),
                text(row.kind),
                text(row.payload_json),
            ],
        )?;
        run(&self.move_mark, vec![Value::Real(row.seq)])?;
        Ok(())
    }
}

/// Bind and step a read once; the next `bind` resets it.
fn stmt_step(
    statement: &Statement,
    params: Vec<Value>,
) -> Result<Option<Vec<Value>>, crate::Error> {
    let bound: Vec<Option<Value>> = params.into_iter().map(Some).collect();
    statement.bind(&bound)?;
    statement.step()
}
