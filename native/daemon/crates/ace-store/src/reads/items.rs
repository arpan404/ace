// SPDX-License-Identifier: Apache-2.0
//! Phase 1b: item pages, windows and tails (docs/store/porting-guide.md).
//!
//! Each read runs on the store's own connection, so it sees an open write exactly as the
//! TypeScript loader would, and assembles its whole answer from a handful of statements. Stored
//! JSON goes out as stored; rows below the trust floor are marked for the shell, which decodes
//! them with the existing lenient decoders. The shell reports errors by variant.
//!
//! One module per loader family so they stay small: `json` and `parse` hold the lossless
//! JSON model every read assembles, `text` and `chunks` the preview and chunk reads, `fetch`
//! the batched row reads, `paging` the page loaders, `tail` the snapshot tail, `cache` the
//! shared wire cache, `bounded` the bounded-page reduction, `window` the items window.
//! Sibling phases own their own files.

#[path = "items/bounded.rs"]
mod bounded;
#[path = "items/cache.rs"]
mod cache;
#[path = "items/chunks.rs"]
mod chunks;
#[path = "items/decode.rs"]
mod decode;
#[path = "items/fetch.rs"]
mod fetch;
#[path = "items/json.rs"]
mod json;
#[path = "items/paging.rs"]
mod paging;
#[path = "items/parse.rs"]
mod parse;
#[path = "items/tail.rs"]
mod tail;
#[path = "items/text.rs"]
mod text;
#[path = "items/window.rs"]
mod window;

pub use paging::{page, wire_page};
pub use tail::tail_rows;
pub use window::{WindowQuery, window};

use crate::{Connection, Error as StoreError, Value};
use std::collections::HashSet;
use std::sync::Arc;

/// Why an item read failed. The binding maps each variant to the error the shell reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    Store(StoreError),
    /// A page's byte budget cannot start with its newest item.
    Capacity,
    /// `materialize` of an id whose body row is gone: `JSON.parse("undefined")` in TypeScript.
    UndefinedJson,
    /// A row a reader needs is missing or malformed.
    Row(&'static str),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Store(error) => write!(f, "{error}"),
            ReadError::Capacity => write!(f, "Item detail exceeds page capacity"),
            ReadError::UndefinedJson => write!(f, "Missing item body"),
            ReadError::Row(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ReadError {}

pub type Result<T> = std::result::Result<T, ReadError>;

/// Which stored rows are read as stored: rows at `from` on, except `rejected` ones. The
/// rejected set stays a set, not a scan: trust is checked per row of every page.
#[derive(Debug, Clone, Copy)]
pub struct Trust<'a> {
    pub from: Option<i64>,
    pub rejected: &'a HashSet<i64>,
}

fn trusted(trust: Trust, seq: i64) -> bool {
    trust.from.is_some_and(|from| seq >= from) && !trust.rejected.contains(&seq)
}

/// Run `sql` with `params` and collect every row, as the store's `all` does.
fn all(conn: &Arc<Connection>, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>> {
    let statement = conn.prepare(sql).map_err(ReadError::Store)?;
    let bound: Vec<Option<Value>> = params.iter().cloned().map(Some).collect();
    statement.bind(&bound).map_err(ReadError::Store)?;
    let mut rows = Vec::new();
    while let Some(row) = statement.step().map_err(ReadError::Store)? {
        rows.push(row);
    }
    Ok(rows)
}

/// The first row of `sql`, if any. Dropping the statement releases its read snapshot.
fn one(conn: &Arc<Connection>, sql: &str, params: &[Value]) -> Result<Option<Vec<Value>>> {
    let statement = conn.prepare(sql).map_err(ReadError::Store)?;
    let bound: Vec<Option<Value>> = params.iter().cloned().map(Some).collect();
    statement.bind(&bound).map_err(ReadError::Store)?;
    statement.step().map_err(ReadError::Store)
}

fn int(cell: &Value) -> Result<i64> {
    match cell {
        Value::Integer(n) => Ok(*n),
        _ => Err(ReadError::Row("Invalid stored item")),
    }
}

fn opt_int(cell: &Value) -> Result<Option<i64>> {
    match cell {
        Value::Null => Ok(None),
        Value::Integer(n) => Ok(Some(*n)),
        _ => Err(ReadError::Row("Invalid stored item")),
    }
}

fn text(cell: &Value) -> Result<&str> {
    match cell {
        Value::Text(value) => Ok(value),
        _ => Err(ReadError::Row("Invalid stored item")),
    }
}

fn cell(row: &[Value], index: usize) -> Result<&Value> {
    row.get(index).ok_or(ReadError::Row("Invalid stored item"))
}
