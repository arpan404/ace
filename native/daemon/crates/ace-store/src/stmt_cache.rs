// SPDX-License-Identifier: Apache-2.0
//! Cached prepared statements, one cache per connection.
//!
//! Long-thread reads (and later phases) issue the same few `SELECT`s on every call:
//! a turns page used to prepare 50+ statements per call. Preparing parses and plans
//! the SQL each time, so the cache prepares once per static SQL text per connection
//! and reuses the statement.
//!
//! - Keyed by the static SQL text (`&'static str`): call sites use string literals,
//!   never built SQL. Variable lists go through `json_each(?)` with a JSON param,
//!   so the text stays fixed while the params vary.
//! - Held per connection: a global map keyed by the connection's address, each entry
//!   a separate `HashMap` that is never shared across connections.
//! - Reuse resets and clears bindings exactly like `sqlite.rs` does on reuse: every
//!   use goes through `Statement::bind`, which resets, clears bindings, then binds.
//! - Cleared when the connection closes (detected via `is_open()`; the entry is
//!   removed) or on schema change (a `SQLITE_SCHEMA` step clears that entry and
//!   retries once). Call `clear(conn)` explicitly after DDL if you want it immediate.
//! - Thread-safe: the global map has its own `Mutex`; SQLite work never holds it
//!   (statements are removed, used, then reinserted). `Connection`'s own `Mutex`
//!   serializes SQLite ops.
//!
//! Other phases: use `all_rows(conn, sql, params)` / `get_row(conn, sql, params)`
//! instead of `conn.prepare(...)` directly. `sql` must be `'static`. Never share
//! a cache across connections; the API enforces it by keying on the connection.

use crate::{Connection, Error, ErrorKind, Statement, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

/// One row as column name to value.
pub type Row = BTreeMap<String, Value>;

static CACHE: OnceLock<Mutex<HashMap<usize, HashMap<&'static str, Statement>>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<usize, HashMap<&'static str, Statement>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(conn: &Arc<Connection>) -> usize {
    Arc::as_ptr(conn) as usize
}

fn closed() -> Error {
    Error {
        kind: ErrorKind::Closed,
        code: 0,
        message: "database is not open".to_owned(),
        errstr: String::new(),
    }
}

/// Drop the cached statements for `conn`. Call after DDL if you want schema
/// changes to take effect immediately; schema errors also clear on retry.
pub fn clear(conn: &Arc<Connection>) {
    let removed = {
        let mut cache = cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.remove(&key(conn))
    };
    drop(removed);
}

fn take(conn: &Arc<Connection>, sql: &'static str) -> Result<Option<Statement>, Error> {
    if !conn.is_open() {
        clear(conn);
        return Err(closed());
    }
    let mut cache = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(sub) = cache.get_mut(&key(conn))
        && let Some(statement) = sub.remove(sql)
    {
        return Ok(Some(statement));
    }
    Ok(None)
}

fn put(conn: &Arc<Connection>, sql: &'static str, statement: Statement) {
    if !conn.is_open() {
        return;
    }
    let mut cache = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.entry(key(conn)).or_default().insert(sql, statement);
}

fn is_schema(error: &Error) -> bool {
    error.kind == ErrorKind::Sqlite && error.code == libsqlite3_sys::SQLITE_SCHEMA
}

fn columns(statement: &Statement) -> Result<Vec<String>, Error> {
    statement.columns()
}

fn bind(statement: &Statement, params: Vec<Value>) -> Result<(), Error> {
    let bound: Vec<Option<Value>> = params.into_iter().map(Some).collect();
    statement.bind(&bound)
}

/// Run `sql` with `params` and return every row's cells, in column order.
/// No column names, no maps: callers use indices from the `SELECT` list.
/// Fewer allocations than `all_rows` (no per-row map, no key clones).
pub fn all_rows_raw(
    conn: &Arc<Connection>,
    sql: &'static str,
    params: Vec<Value>,
) -> Result<Vec<Vec<Value>>, Error> {
    // Retry once after a schema change: drop the stale prepared statement.
    let mut retried = false;
    loop {
        let statement = match take(conn, sql)? {
            Some(statement) => statement,
            None => conn.prepare(sql)?,
        };
        if let Err(error) = bind(&statement, params.clone()) {
            if !retried && is_schema(&error) {
                clear(conn);
                retried = true;
                continue;
            }
            put(conn, sql, statement);
            return Err(error);
        }
        let mut rows = Vec::new();
        let mut failed: Option<Error> = None;
        loop {
            match statement.step() {
                Ok(None) => break,
                Ok(Some(cells)) => {
                    rows.push(cells);
                }
                Err(error) => {
                    failed = Some(error);
                    break;
                }
            }
        }
        if let Some(error) = failed {
            if !retried && is_schema(&error) {
                clear(conn);
                retried = true;
                continue;
            }
            put(conn, sql, statement);
            return Err(error);
        }
        put(conn, sql, statement);
        return Ok(rows);
    }
}

/// The first row's cells of `sql`, if any, in column order.
pub fn get_row_raw(
    conn: &Arc<Connection>,
    sql: &'static str,
    params: Vec<Value>,
) -> Result<Option<Vec<Value>>, Error> {
    let mut rows = all_rows_raw(conn, sql, params)?;
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rows.remove(0)))
    }
}

/// Run `sql` with `params` and return every row, keyed by column name.
pub fn all_rows(
    conn: &Arc<Connection>,
    sql: &'static str,
    params: Vec<Value>,
) -> Result<Vec<Row>, Error> {
    // Retry once after a schema change: drop the stale prepared statement.
    let mut retried = false;
    loop {
        let statement = match take(conn, sql)? {
            Some(statement) => statement,
            None => conn.prepare(sql)?,
        };
        let columns = match columns(&statement) {
            Ok(columns) => columns,
            Err(error) => {
                if !retried && is_schema(&error) {
                    clear(conn);
                    retried = true;
                    continue;
                }
                put(conn, sql, statement);
                return Err(error);
            }
        };
        if let Err(error) = bind(&statement, params.clone()) {
            if !retried && is_schema(&error) {
                clear(conn);
                retried = true;
                continue;
            }
            put(conn, sql, statement);
            return Err(error);
        }
        let mut rows = Vec::new();
        let mut failed: Option<Error> = None;
        loop {
            match statement.step() {
                Ok(None) => break,
                Ok(Some(cells)) => {
                    let mut row = BTreeMap::new();
                    for (index, name) in columns.iter().enumerate() {
                        let cell = cells.get(index).cloned().unwrap_or(Value::Null);
                        row.insert(name.clone(), cell);
                    }
                    rows.push(row);
                }
                Err(error) => {
                    failed = Some(error);
                    break;
                }
            }
        }
        if let Some(error) = failed {
            if !retried && is_schema(&error) {
                clear(conn);
                retried = true;
                continue;
            }
            put(conn, sql, statement);
            return Err(error);
        }
        put(conn, sql, statement);
        return Ok(rows);
    }
}

/// The first row of `sql`, if any.
pub fn get_row(
    conn: &Arc<Connection>,
    sql: &'static str,
    params: Vec<Value>,
) -> Result<Option<Row>, Error> {
    let mut rows = all_rows(conn, sql, params)?;
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(rows.remove(0)))
    }
}
