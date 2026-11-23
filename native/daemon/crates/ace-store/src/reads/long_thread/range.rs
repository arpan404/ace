// SPDX-License-Identifier: Apache-2.0
//! Persisted range sums, as `long-thread/range-shape.ts` and `ranges.ts` read them.
//!
//! Rows arrive as cells in the `SELECT` list's order; owners keep the order the
//! caller named them in, because summaries read one owner's counters at a time.

use super::common::{LongError, all_rows_raw};
use super::row::{strs_json, text_at};
use super::turns_types::Counters;
use crate::{Connection, Value};
use std::sync::Arc;

pub fn range_buckets(position: i64) -> Vec<(i64, i64)> {
    let value = position.clamp(0, 9007199254740991);
    let mut out = Vec::new();
    for level in 0..7 {
        let divisor: i64 = 1 << (8 * level);
        out.push((level as i64, value / divisor));
    }
    out
}

pub fn range_prefix(cutoff: i64) -> Vec<(i64, i64, i64)> {
    range_buckets(cutoff)
        .into_iter()
        .map(|(level, bucket)| {
            let low = bucket / 256 * 256;
            let high = bucket + if level == 0 { 1 } else { 0 };
            (level, low, high)
        })
        .collect()
}

pub fn range_suffix(cutoff: i64) -> Vec<(i64, i64, i64)> {
    range_buckets(cutoff)
        .into_iter()
        .map(|(level, bucket)| {
            let low = bucket + 1;
            let high = if level == 6 {
                32
            } else {
                (bucket / 256 + 1) * 256
            };
            (level, low, high)
        })
        .collect()
}

/// One owner's counters after a cutoff, with the owner's name.
pub struct OwnerCounters {
    pub owner: String,
    pub counters: Counters,
}

pub fn find_counters<'a>(values: &'a [OwnerCounters], owner: &str) -> Option<&'a Counters> {
    values
        .iter()
        .find(|entry| entry.owner == owner)
        .map(|entry| &entry.counters)
}

pub fn range_after(
    conn: &Arc<Connection>,
    thread: &str,
    owners: &[String],
    cutoff: i64,
) -> Result<Vec<OwnerCounters>, LongError> {
    const SQL: &str = "WITH bounds(level,low,high) AS (VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?)),
      sums AS (
        SELECT owner,key,SUM(value) AS value FROM long_range_nodes
        WHERE thread_id=? AND owner IN (SELECT value FROM json_each(?)) AND level=6 GROUP BY owner,key
        UNION ALL
        SELECT n.owner,n.key,-SUM(n.value) AS value FROM bounds b CROSS JOIN long_range_nodes n
        WHERE n.thread_id=? AND n.owner IN (SELECT value FROM json_each(?)) AND n.level=b.level AND n.bucket>=b.low AND n.bucket<b.high GROUP BY n.owner,n.key
      ) SELECT owner,key,SUM(value) AS value FROM sums GROUP BY owner,key";
    let bounds = range_prefix(cutoff);
    let owners_json = strs_json(owners)?;
    let mut params = Vec::new();
    for (level, low, high) in &bounds {
        params.push(Value::Integer(*level));
        params.push(Value::Integer(*low));
        params.push(Value::Integer(*high));
    }
    params.push(Value::Text(thread.to_owned()));
    params.push(Value::Text(owners_json.clone()));
    params.push(Value::Text(thread.to_owned()));
    params.push(Value::Text(owners_json));
    let rows = all_rows_raw(conn, SQL, params)?;
    let mut result: Vec<OwnerCounters> = Vec::new();
    for row in rows {
        let owner = text_at(&row, 0)?.to_owned();
        let key = match text_at(&row, 1) {
            Ok(key) => key.to_owned(),
            Err(_) => continue,
        };
        let value = match row.get(2) {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => continue,
        };
        match result.iter_mut().find(|entry| entry.owner == owner) {
            Some(entry) => entry.counters.insert(key, value),
            None => {
                let mut counters = Counters::new();
                counters.insert(key, value);
                result.push(OwnerCounters { owner, counters });
            }
        }
    }
    Ok(result)
}

/// A prefix lookup that reads as zero when the row is missing or null.
pub fn prefix_number(row: &[Value], index: usize) -> i64 {
    match row.get(index) {
        Some(Value::Integer(n)) => *n,
        Some(Value::Real(n)) => *n as i64,
        _ => 0,
    }
}
