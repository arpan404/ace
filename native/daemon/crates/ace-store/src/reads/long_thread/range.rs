// SPDX-License-Identifier: Apache-2.0
//! Persisted range sums, as `long-thread/range-shape.ts` and `ranges.ts` read them.

use super::common::{LongError, all_rows};
use crate::{Connection, Value};
use std::collections::BTreeMap;
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

pub type Counters = BTreeMap<String, i64>;

pub fn range_after(
    conn: &Arc<Connection>,
    thread: &str,
    owners: &[String],
    cutoff: i64,
) -> Result<BTreeMap<String, Counters>, LongError> {
    const SQL: &str = "WITH bounds(level,low,high) AS (VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?)),
      sums AS (
        SELECT owner,key,SUM(value) AS value FROM long_range_nodes
        WHERE thread_id=? AND owner IN (SELECT value FROM json_each(?)) AND level=6 GROUP BY owner,key
        UNION ALL
        SELECT n.owner,n.key,-SUM(n.value) AS value FROM bounds b CROSS JOIN long_range_nodes n
        WHERE n.thread_id=? AND n.owner IN (SELECT value FROM json_each(?)) AND n.level=b.level AND n.bucket>=b.low AND n.bucket<b.high GROUP BY n.owner,n.key
      ) SELECT owner,key,SUM(value) AS value FROM sums GROUP BY owner,key";
    let bounds = range_prefix(cutoff);
    let owners_json = serde_json::to_string(&owners)
        .map_err(|error| super::common::invalid(&error.to_string()))?;
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
    let rows = all_rows(conn, SQL, params)?;
    let mut result: BTreeMap<String, Counters> = BTreeMap::new();
    for row in rows {
        let owner = match row.get("owner") {
            Some(Value::Text(text)) => text.clone(),
            _ => continue,
        };
        let key = match row.get("key") {
            Some(Value::Text(text)) => text.clone(),
            _ => continue,
        };
        let value = match row.get("value") {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            Some(Value::Null) => continue,
            _ => continue,
        };
        result.entry(owner).or_default().insert(key, value);
    }
    Ok(result)
}
