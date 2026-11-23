// SPDX-License-Identifier: Apache-2.0
//! A page's turn rows, read and validated in `SELECT` order.

use super::super::common::{
    LongError, check_count, check_ordinal, check_timestamp, get_row_raw, invalid,
};
use super::super::row::{int_at, opt_int_at, text_at};
use crate::{Connection, Value};
use std::sync::Arc;

pub struct TurnRow {
    pub ordinal: i64,
    pub start_seq: i64,
    pub end_seq: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub root_outcome: String,
    pub settled_seq: Option<i64>,
    pub initiating: String,
    pub latest: String,
}

pub fn parse_turn_row(row: &[Value]) -> Result<TurnRow, LongError> {
    let ordinal = check_ordinal(int_at(row, 1)?)?;
    let start_seq = check_count(int_at(row, 2)?)?;
    let end_seq = check_count(int_at(row, 3)?)?;
    let started_at = check_timestamp(int_at(row, 4)?)?;
    let ended_at = match opt_int_at(row, 5)? {
        None => None,
        Some(ended) => Some(check_timestamp(ended)?),
    };
    let root_outcome = text_at(row, 7)?;
    if !matches!(
        root_outcome,
        "active" | "completed" | "interrupted" | "failed"
    ) {
        return Err(invalid("invalid index row"));
    }
    let root_outcome = root_outcome.to_owned();
    let settled_seq = match row.get(8).ok_or_else(|| invalid("invalid index row"))? {
        Value::Null => None,
        Value::Integer(n) => Some(*n),
        Value::Real(n) => Some(*n as i64),
        _ => return Err(invalid("invalid index row")),
    };
    let initiating = super::super::common::as_preview_raw(text_at(row, 9)?)?.to_owned();
    let latest = super::super::common::as_preview_raw(text_at(row, 10)?)?.to_owned();
    Ok(TurnRow {
        ordinal,
        start_seq,
        end_seq,
        started_at,
        ended_at,
        root_outcome,
        settled_seq,
        initiating,
        latest,
    })
}

pub fn digest_indexed_seq(conn: &Arc<Connection>) -> Result<i64, LongError> {
    let stage = get_row_raw(
        conn,
        "SELECT stage FROM long_range_migration WHERE id=1",
        Vec::new(),
    )?;
    let stage = match stage.as_ref().and_then(|row| row.first()) {
        Some(Value::Integer(n)) => *n,
        Some(Value::Real(n)) => *n as i64,
        _ => return Ok(0),
    };
    if stage != 6 {
        return Ok(0);
    }
    let seq = get_row_raw(conn, "SELECT seq FROM long_meta WHERE id=1", Vec::new())?;
    match seq.as_ref().and_then(|row| row.first()) {
        Some(Value::Integer(n)) => Ok(*n),
        Some(Value::Real(n)) => Ok(*n as i64),
        _ => Ok(0),
    }
}
