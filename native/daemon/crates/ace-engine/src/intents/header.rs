// SPDX-License-Identifier: Apache-2.0
//! `IntentHeader` (`intents.ts:9`-`:50`): one live intent's indexed row. `status` and `delivery`
//! decode strictly, as zod does; a row this build cannot read is passed to `headers`'s
//! `unreadable` callback and skipped, or fails the read when there is none.

use ace_store::stmt_cache::Row;
use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::EngineError;

/// The columns every header read selects, in `intents.ts:29`'s order.
pub const COLUMNS: &str = "id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id";

pub const STATUSES: [&str; 5] = ["pending", "queued", "running", "done", "failed"];
pub const DELIVERIES: [&str; 2] = ["queue", "steer"];
pub const TRIGGERS: [&str; 11] = [
    "user",
    "restart",
    "limit_resume",
    "spawn",
    "parent_agent",
    "background_completion",
    "subagent_result",
    "goal",
    "queue",
    "schedule",
    "unknown",
];

/// One intent's header, as `Header.parse` keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentHeader {
    pub id: i64,
    pub thread_id: String,
    pub command_id: String,
    pub kind: String,
    pub status: String,
    pub attempts: i64,
    pub awaiting: bool,
    pub ack_target: Option<i64>,
    pub delivery: String,
    pub acknowledged: bool,
    pub resolution_id: Option<String>,
    pub resolution_generation: Option<i64>,
    pub submitted_generation: Option<i64>,
    pub trigger: Option<String>,
}

/// A stored intent: its header and the command payload the row holds.
#[derive(Debug, Clone)]
pub struct Intent {
    pub header: IntentHeader,
    pub command: ace_json::Value,
}

fn text(row: &Row, key: &str) -> Result<String, EngineError> {
    match row.get(key) {
        Some(Value::Text(value)) => Ok(value.clone()),
        _ => Err(unreadable(key)),
    }
}

fn integer(row: &Row, key: &str) -> Result<i64, EngineError> {
    match row.get(key) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => Err(unreadable(key)),
    }
}

fn optional_integer(row: &Row, key: &str) -> Result<Option<i64>, EngineError> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => Err(unreadable(key)),
    }
}

fn optional_text(row: &Row, key: &str) -> Result<Option<String>, EngineError> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::Text(value)) => Ok(Some(value.clone())),
        _ => Err(unreadable(key)),
    }
}

/// `row.awaiting === 1`: any other cell (0, 2, a string) decodes as false, as TS's `=== 1`.
fn flag(row: &Row, key: &str) -> bool {
    matches!(row.get(key), Some(Value::Integer(1)))
}

/// A branded id: a non-empty string (`ids.ts:8`).
fn non_empty(row: &Row, key: &str) -> Result<String, EngineError> {
    let value = text(row, key)?;
    if value.is_empty() {
        return Err(unreadable(key));
    }
    Ok(value)
}

fn member<'a>(allowed: &'a [&'a str], value: String, key: &str) -> Result<String, EngineError> {
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(unreadable(key))
    }
}

fn unreadable(key: &str) -> EngineError {
    EngineError::Records(format!("Invalid intent header: {key}"))
}

impl IntentHeader {
    /// `header(row)` (`intents.ts:33`): the row as the strict schema reads it.
    pub fn from_row(row: &Row) -> Result<IntentHeader, EngineError> {
        let id = integer(row, "id")?;
        if id <= 0 {
            return Err(unreadable("id"));
        }
        let attempts = integer(row, "attempts")?;
        if attempts < 0 {
            return Err(unreadable("attempts"));
        }
        let ack_target = optional_integer(row, "ack_target")?;
        if ack_target.is_some_and(|value| value <= 0) {
            return Err(unreadable("ack_target"));
        }
        let resolution_generation = optional_integer(row, "resolution_generation")?;
        if resolution_generation.is_some_and(|value| value < 0) {
            return Err(unreadable("resolution_generation"));
        }
        let submitted_generation = optional_integer(row, "submitted_generation")?;
        if submitted_generation.is_some_and(|value| value < 0) {
            return Err(unreadable("submitted_generation"));
        }
        let status = member(&STATUSES, text(row, "status")?, "status")?;
        let delivery = member(&DELIVERIES, text(row, "delivery")?, "delivery")?;
        let trigger = optional_text(row, "trigger")?
            .map(|trigger| member(&TRIGGERS, trigger, "trigger"))
            .transpose()?;
        Ok(IntentHeader {
            id,
            thread_id: non_empty(row, "thread_id")?,
            command_id: non_empty(row, "command_id")?,
            kind: text(row, "kind")?,
            status,
            attempts,
            awaiting: flag(row, "awaiting"),
            ack_target,
            delivery,
            acknowledged: flag(row, "acknowledged"),
            resolution_id: optional_text(row, "resolution_id")?.filter(|value| !value.is_empty()),
            resolution_generation,
            submitted_generation,
            trigger,
        })
    }
}

impl Intent {
    /// The row and its payload as `claim`/`uncertainSends` read it.
    pub fn with_command(row: &Row) -> Result<Intent, EngineError> {
        let payload = text(row, "payload")?;
        let command = super::command::parse(&payload)?;
        Ok(Intent {
            header: IntentHeader::from_row(row)?,
            command,
        })
    }
}

/// `unreadable`'s signature: the row's raw thread cell and why this build can't read it.
pub type Unreadable<'a> = &'a mut dyn FnMut(Option<&Value>, &EngineError);

/// `headers` (`intents.ts:133`): live intents by `id>?`, 64 at a time, skipping (or failing on)
/// a row the decoder refuses.
pub fn headers(
    conn: &Arc<ace_store::Connection>,
    thread: Option<&str>,
    mut unreadable: Option<Unreadable<'_>>,
) -> Result<Vec<IntentHeader>, EngineError> {
    const ALL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE id>? AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) ORDER BY id LIMIT 64";
    const THREAD: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND id>? AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) ORDER BY id LIMIT 64";
    let mut all = Vec::new();
    let mut after = 0i64;
    loop {
        let rows = match thread {
            None => stmt_cache::all_rows(conn, ALL, vec![Value::Integer(after)])?,
            Some(thread) => stmt_cache::all_rows(
                conn,
                THREAD,
                vec![Value::Text(thread.to_owned()), Value::Integer(after)],
            )?,
        };
        if rows.is_empty() {
            return Ok(all);
        }
        for row in rows {
            after = integer(&row, "id")?;
            match IntentHeader::from_row(&row) {
                Ok(header) => all.push(header),
                Err(error) => match unreadable.as_mut() {
                    Some(callback) => callback(row.get("thread_id"), &error),
                    None => return Err(error),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{header, home};

    #[test]
    fn awaiting_decodes_as_the_typescripts_triple_equals_one() {
        let conn = home("header-await", &header("header-await"));
        // 2 is not 1: false, not unreadable.
        conn.exec(
            "INSERT INTO intents (id,command_id,thread_id,kind,payload,status,attempts,awaiting,acknowledged,delivery,position) \
             VALUES (1,'one','header-await','thread.send','{}','pending',0,2,'x','queue',1)",
        )
        .unwrap();
        let read = headers(&conn, Some("header-await"), None).unwrap();
        assert_eq!(read.len(), 1);
        assert!(!read[0].awaiting);
        assert!(!read[0].acknowledged);
    }

    #[test]
    fn an_unreadable_row_passes_its_raw_thread_cell_to_the_callback() {
        let conn = home("header-raw", &header("header-raw"));
        conn.exec("PRAGMA foreign_keys=OFF").unwrap();
        // An empty branded id and a non-text thread cell both go to the callback.
        conn.exec("INSERT INTO intents (id,command_id,thread_id,kind,payload,status,attempts,awaiting,acknowledged,delivery,position) VALUES (1,'','header-raw','thread.send','{}','pending',0,0,0,'queue',1)").unwrap();
        conn.exec("INSERT INTO intents (id,command_id,thread_id,kind,payload,status,attempts,awaiting,acknowledged,delivery,position) VALUES (2,'two',CAST(x'37' AS BLOB),'thread.send','{}','pending',0,0,0,'queue',2)").unwrap();
        let mut seen: Vec<(Option<Value>, String)> = Vec::new();
        // The all-threads scan has no thread filter, so the non-text thread cell reaches the
        // callback raw.
        let read = headers(
            &conn,
            None,
            Some(&mut |cell, error| seen.push((cell.cloned(), error.to_string()))),
        )
        .unwrap();
        assert!(read.is_empty());
        assert_eq!(seen.len(), 2);
        assert!(seen[0].1.contains("command_id"));
        assert!(matches!(seen[1].0, Some(Value::Blob(_))));
        assert!(seen[1].1.contains("thread_id"));
        // With no callback the same rows fail the read.
        assert!(headers(&conn, None, None).is_err());
        // A valid row still decodes once the unreadable ones are gone.
        conn.exec("DELETE FROM intents WHERE id IN (1,2)").unwrap();
        conn.exec("INSERT INTO intents (id,command_id,thread_id,kind,payload,status,attempts,awaiting,acknowledged,delivery,position) VALUES (3,'three','header-raw','thread.send','{}','pending',0,0,0,'queue',3)").unwrap();
        assert_eq!(headers(&conn, Some("header-raw"), None).unwrap().len(), 1);
    }

    #[test]
    fn an_intent_id_above_2_32_round_trips() {
        let conn = home("header-big", &header("header-big"));
        conn.exec("INSERT INTO intents (id,command_id,thread_id,kind,payload,status,attempts,awaiting,acknowledged,delivery,position) VALUES (4294967297,'big','header-big','thread.send','{}','pending',0,0,0,'queue',1)").unwrap();
        let read = headers(&conn, Some("header-big"), None).unwrap();
        assert_eq!(read[0].id, 4_294_967_297);
    }
}
