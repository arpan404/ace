// SPDX-License-Identifier: Apache-2.0
//! Index-free row access for phase 2 reads.
//!
//! The statement cache's `all_rows_raw` returns each row's cells in the `SELECT`
//! list's order, without a per-row name map. These helpers read cells by index
//! and borrow text straight from the cell, so a read never clones a column name
//! or builds a map per row. Every accessor fails with the loader's message when
//! a cell is missing or mistyped, exactly as the map lookups did.

use super::common::{LongError, integer_value, invalid};
use crate::Value;

/// One row's cells, in the `SELECT` list's order.
pub type Cells = Vec<Value>;

fn cell(row: &[Value], index: usize) -> Result<&Value, LongError> {
    row.get(index).ok_or_else(|| invalid("invalid index row"))
}

/// Borrowed text of cell `index`; fails on NULL or a non-text cell.
pub fn text_at(row: &[Value], index: usize) -> Result<&str, LongError> {
    match cell(row, index)? {
        Value::Text(text) => Ok(text.as_str()),
        _ => Err(invalid("invalid index row")),
    }
}

/// An integer cell: SQLite integers, or whole-valued reals.
pub fn int_at(row: &[Value], index: usize) -> Result<i64, LongError> {
    integer_value(cell(row, index)?)
}

/// An optional integer cell: NULL reads as none.
pub fn opt_int_at(row: &[Value], index: usize) -> Result<Option<i64>, LongError> {
    match cell(row, index)? {
        Value::Null => Ok(None),
        value => Ok(Some(integer_value(value)?)),
    }
}

/// An optional text cell: NULL reads as none.
pub fn opt_text_at(row: &[Value], index: usize) -> Result<Option<&str>, LongError> {
    match cell(row, index)? {
        Value::Null => Ok(None),
        Value::Text(text) => Ok(Some(text.as_str())),
        _ => Err(invalid("invalid index row")),
    }
}

/// The JSON encoding of one string, as `JSON.stringify` writes it.
pub fn json_string(text: &str) -> Result<String, LongError> {
    serde_json::to_string(text).map_err(|error| invalid(&error.to_string()))
}

/// The JSON encoding of integer ids, `[1,2]` with no spaces.
pub fn ints_json(values: &[i64]) -> String {
    let mut out = String::with_capacity(values.len() * 8 + 2);
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

/// The JSON encoding of string ids, with each entry escaped once.
pub fn strs_json(values: &[String]) -> Result<String, LongError> {
    let mut out = String::with_capacity(values.len() * 40 + 2);
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&json_string(value)?);
    }
    out.push(']');
    Ok(out)
}

/// The JSON encoding of `[thread, ordinal]` pairs, escaped once each.
pub fn turn_keys_json(keys: &[(String, i64)]) -> Result<String, LongError> {
    let mut out = String::with_capacity(keys.len() * 48 + 2);
    out.push('[');
    for (index, (thread, ordinal)) in keys.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&json_string(thread)?);
        out.push(',');
        out.push_str(&ordinal.to_string());
        out.push(']');
    }
    out.push(']');
    Ok(out)
}

/// The JSON encoding of `[ordinal, agent]` pairs, escaped once each.
pub fn agent_keys_json(keys: &[(i64, String)]) -> Result<String, LongError> {
    let mut out = String::with_capacity(keys.len() * 48 + 2);
    out.push('[');
    for (index, (ordinal, agent)) in keys.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&ordinal.to_string());
        out.push(',');
        out.push_str(&json_string(agent)?);
        out.push(']');
    }
    out.push(']');
    Ok(out)
}
