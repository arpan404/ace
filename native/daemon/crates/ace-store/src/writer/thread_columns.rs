// SPDX-License-Identifier: Apache-2.0
//! The thread column writes (task 5.3b-2): `writeThread` in `apps/daemon/src/event-writer.ts`
//! through its revision read. The change set and the encodings are `ace-projection`'s (5.3b-1);
//! this module runs the three statements in the same order the TypeScript runs them.
//!
//! The SQL texts are the TypeScript's, byte for byte: the variable lists are built from the
//! change set, so the UPDATE and the cold upsert are prepared on first use and cached by the
//! set of columns they name. The writer holds statements and the connection, never a thread or
//! a previous encoding. Readers are reset after their step, as 5.3a's review required.
//!
//! Zod validation stays TypeScript: an invalid value is copied and stored, and `rebuildThread`
//! rejects it inside the caller's transaction, which rolls the write back. The previous details
//! a cold upsert rebinds are the exception: Rust parses them there, as the shell's TypeScript
//! does, so an invalid stored value fails the write instead of being silently shaped.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;

use ace_json::{JsString, Map, Number, Value as JsonValue};
use ace_projection::{Column, ColumnValue, Part, cold_row_values, column_changes, column_value};

use crate::sqlite::Statement;
use crate::{Connection, Error, Value};

use super::events::WriteError;

/// `SELECT 1 FROM thread_row_trust ...`: the pre-write confirmation (`thread-row-trust.ts:189`).
const THREAD_ROW_CONFIRMED: &str = "SELECT 1 FROM thread_row_trust AS trust JOIN sidebar_thread_revisions AS current ON current.thread_id = trust.thread_id AND current.revision = trust.revision WHERE trust.thread_id = ? AND trust.canonical = 1";
/// `SELECT revision FROM sidebar_thread_revisions WHERE thread_id = ?`.
const REVISION: &str = "SELECT revision FROM sidebar_thread_revisions WHERE thread_id = ?";

/// What `writeThread` wrote, for the shell's `rebuildThread`.
pub struct Written {
    pub row: Vec<(Column, ColumnValue)>,
    pub parts: Vec<Part>,
    /// No `previous`, or `threadRowConfirmed`, read before the writes.
    pub confirmed: bool,
    /// `SELECT revision FROM sidebar_thread_revisions WHERE thread_id = ?`; None when there is
    /// no row or the value isn't a number.
    pub revision: Option<f64>,
}

/// The cached statements only; no thread state.
pub struct ThreadColumnWriter {
    connection: Arc<Connection>,
    confirmed: Statement,
    revision: Statement,
    /// Prepared UPDATEs, keyed by the hot columns' mask (their order is always `wanted`'s).
    updates: HashMap<u16, Statement>,
    /// Prepared cold upserts, keyed by the cold columns' mask.
    upserts: HashMap<u16, Statement>,
}

/// The bit naming `column` in a statement's mask.
fn bit(column: Column) -> u16 {
    let index = Column::ALL
        .iter()
        .position(|candidate| *candidate == column)
        .unwrap_or(0);
    1u16 << index
}

fn mask_of(columns: &[(Column, ColumnValue)]) -> u16 {
    columns
        .iter()
        .fold(0, |mask, (column, _)| mask | bit(*column))
}

/// `UPDATE threads SET a = ?, b = ? WHERE id = ?`.
fn update_sql(columns: &[(Column, ColumnValue)]) -> String {
    let assignments: Vec<String> = columns
        .iter()
        .map(|(column, _)| format!("{} = ?", column.name()))
        .collect();
    format!("UPDATE threads SET {} WHERE id = ?", assignments.join(", "))
}

/// The `thread_cold` upsert with one `name = excluded.name` per cold column.
fn upsert_sql(columns: &[(Column, ColumnValue)]) -> String {
    let assignments: Vec<String> = columns
        .iter()
        .map(|(column, _)| format!("{} = excluded.{}", column.name(), column.name()))
        .collect();
    format!(
        "INSERT INTO thread_cold (thread_id, details, capabilities) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET {}",
        assignments.join(", ")
    )
}

/// Text as node:sqlite binds it: a lone surrogate in a plain text column becomes U+FFFD.
fn bind_value(value: &ColumnValue) -> Value {
    match value {
        ColumnValue::Text(text) => Value::Text(text.to_string_lossy().into_owned()),
        ColumnValue::Number(number) => Value::Real(*number),
        ColumnValue::Null => Value::Null,
    }
}

/// Bind and run one write to completion.
fn run(statement: &Statement, params: Vec<Value>) -> Result<(), Error> {
    let bound: Vec<Option<Value>> = params.into_iter().map(Some).collect();
    statement.bind(&bound)?;
    while statement.step()?.is_some() {}
    Ok(())
}

/// Bind and step one read once, then reset it.
fn read(statement: &Statement, params: Vec<Value>) -> Result<Option<Vec<Value>>, Error> {
    let bound: Vec<Option<Value>> = params.into_iter().map(Some).collect();
    statement.bind(&bound)?;
    let row = statement.step()?;
    statement.reset()?;
    Ok(row)
}

impl ThreadColumnWriter {
    /// Prepare the two fixed reads on `conn`; the variable statements prepare on first use.
    pub fn new(conn: &Arc<Connection>) -> Result<ThreadColumnWriter, Error> {
        Ok(ThreadColumnWriter {
            connection: Arc::clone(conn),
            confirmed: conn.prepare(THREAD_ROW_CONFIRMED)?,
            revision: conn.prepare(REVISION)?,
            updates: HashMap::new(),
            upserts: HashMap::new(),
        })
    }

    /// `writeThread` through the revision read; Ok(None) when no column changed.
    pub fn write(
        &mut self,
        conn: &Connection,
        previous: Option<&Map>,
        next: &Map,
        wanted: &[Column],
    ) -> Result<Option<Written>, WriteError> {
        // The statements hold their connection; `conn` names the same one the shell wrote on.
        let _ = conn;
        let changes = column_changes(previous, next, wanted).map_err(WriteError::Column)?;
        if changes.hot.is_empty() && changes.cold.is_empty() {
            return Ok(None);
        }
        let id = bind_value(&column_value(next, Column::Id).map_err(WriteError::Column)?);
        // A new row is written whole here; an existing one keeps the columns this write leaves.
        let confirmed = match previous {
            None => true,
            Some(_) => {
                let found = read(&self.confirmed, vec![id.clone()])?;
                found.is_some()
            }
        };
        if !changes.hot.is_empty() {
            let mask = mask_of(&changes.hot);
            let statement = match self.updates.entry(mask) {
                Entry::Occupied(entry) => entry.into_mut(),
                Entry::Vacant(entry) => {
                    let prepared = self.connection.prepare(&update_sql(&changes.hot))?;
                    entry.insert(prepared)
                }
            };
            let mut params: Vec<Value> = changes
                .hot
                .iter()
                .map(|(_, value)| bind_value(value))
                .collect();
            params.push(id.clone());
            run(statement, params)?;
        }
        if !changes.cold.is_empty() {
            let values = cold_row_values(previous, &changes).map_err(WriteError::Column)?;
            let mask = mask_of(&changes.cold);
            let statement = match self.upserts.entry(mask) {
                Entry::Occupied(entry) => entry.into_mut(),
                Entry::Vacant(entry) => {
                    let prepared = self.connection.prepare(&upsert_sql(&changes.cold))?;
                    entry.insert(prepared)
                }
            };
            run(
                statement,
                vec![id.clone(), bind_value(&values[0]), bind_value(&values[1])],
            )?;
        }
        let revision = match read(&self.revision, vec![id])? {
            Some(cells) => match cells.first() {
                Some(Value::Integer(value)) => Some(*value as f64),
                Some(Value::Real(value)) => Some(*value),
                _ => None,
            },
            None => None,
        };
        Ok(Some(Written {
            row: changes.row,
            parts: changes.parts,
            confirmed,
            revision,
        }))
    }
}

/// `Written` as the shell reads it: `{"row":{...},"parts":[...],"confirmed":bool,
/// "revision":number|null}`, values as JSON strings, numbers and null.
pub fn written_json(written: &Written) -> String {
    let mut row = Map::new();
    for (column, value) in &written.row {
        row.insert(column.name(), json_value(value));
    }
    let parts: Vec<JsonValue> = written
        .parts
        .iter()
        .map(|part| JsonValue::String(JsString::from(part.name())))
        .collect();
    let mut out = Map::new();
    out.insert("row", JsonValue::Object(row));
    out.insert("parts", JsonValue::Array(parts.into()));
    out.insert("confirmed", JsonValue::Bool(written.confirmed));
    out.insert(
        "revision",
        match written.revision {
            Some(revision) => JsonValue::Number(Number::from_f64_lossy(revision)),
            None => JsonValue::Null,
        },
    );
    ace_json::to_string(&JsonValue::Object(out))
}

fn json_value(value: &ColumnValue) -> JsonValue {
    match value {
        ColumnValue::Text(text) => JsonValue::String(text.clone()),
        ColumnValue::Number(number) => JsonValue::Number(Number::from_f64_lossy(*number)),
        ColumnValue::Null => JsonValue::Null,
    }
}
