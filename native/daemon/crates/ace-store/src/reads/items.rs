// SPDX-License-Identifier: Apache-2.0
//! Phase 1b: item fetches (docs/store/porting-guide.md).
//!
//! Rust FETCHES, TypeScript SHAPES. Each function runs the same batched statements the
//! TypeScript loaders ran, on the store's own connection, and returns the raw column values
//! exactly as stored: stored JSON as strings, numbers as numbers, nulls as nulls. Nothing is
//! parsed, decoded, budgeted or clipped here; TypeScript keeps every step after the fetch.

#[path = "items/fetch.rs"]
mod fetch;
#[path = "items/nav.rs"]
mod nav;
#[path = "items/streams.rs"]
mod streams;

pub use fetch::{bodies, chunks, heads, heads_by_seqs, previews, range_bodies, tail_heads};
pub use nav::{existence, neighbor_seqs, target};
pub use streams::{stream_bytes, stream_sizes};

use crate::{Connection, Error as StoreError, Value};
use std::sync::Arc;

/// Why an item fetch failed. Shaping errors (capacity, missing bodies, clips) stay in
/// TypeScript, where the loaders already throw them; only storage and input failures arise
/// here. The binding reports each variant as the shell expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    Store(StoreError),
    /// A caller-supplied argument is unusable (never a stored row: rows go out as stored).
    Input(&'static str),
    /// Serializing the fetched rows failed.
    Encode(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Store(error) => write!(f, "{error}"),
            FetchError::Input(message) => write!(f, "{message}"),
            FetchError::Encode(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for FetchError {}

pub type Result<T> = std::result::Result<T, FetchError>;

/// Run `sql` with `params` and collect every row, as the store's `all` does.
pub(crate) fn all(conn: &Arc<Connection>, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>> {
    let statement = conn.prepare(sql).map_err(FetchError::Store)?;
    let bound: Vec<Option<Value>> = params.iter().cloned().map(Some).collect();
    statement.bind(&bound).map_err(FetchError::Store)?;
    let mut rows = Vec::new();
    loop {
        match statement.step().map_err(FetchError::Store)? {
            Some(row) => rows.push(row),
            None => return Ok(rows),
        }
    }
}

/// The first row of `sql`, if any.
pub(crate) fn one(
    conn: &Arc<Connection>,
    sql: &str,
    params: &[Value],
) -> Result<Option<Vec<Value>>> {
    let statement = conn.prepare(sql).map_err(FetchError::Store)?;
    let bound: Vec<Option<Value>> = params.iter().cloned().map(Some).collect();
    statement.bind(&bound).map_err(FetchError::Store)?;
    statement.step().map_err(FetchError::Store)
}

/// A fetched row as JSON: text as strings, integers and reals as numbers, blobs as base64
/// strings (see `streams`), nulls as null. Stored JSON stays an opaque string; TypeScript
/// parses it exactly as it does a node:sqlite row.
pub(crate) fn cell_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Integer(n) => serde_json::Value::Number(serde_json::Number::from(*n)),
        Value::Real(n) => serde_json::Number::from_f64(*n)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        Value::Text(text) => serde_json::Value::String(text.clone()),
        Value::Blob(bytes) => serde_json::Value::String(streams::encode_base64(bytes)),
    }
}

/// `rows` with `columns` names as a JSON array string, one object per row.
pub(crate) fn rows_json(columns: &[&str], rows: &[Vec<Value>]) -> Result<String> {
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if row.len() != columns.len() {
            return Err(FetchError::Input("Invalid stored item"));
        }
        let mut map = serde_json::Map::with_capacity(columns.len());
        for (name, value) in columns.iter().zip(row.iter()) {
            map.insert((*name).to_owned(), cell_json(value));
        }
        out.push(serde_json::Value::Object(map));
    }
    serde_json::to_string(&out).map_err(|error| FetchError::Encode(error.to_string()))
}
