// SPDX-License-Identifier: Apache-2.0
//! M3 call records and provider-item correlation on the daemon's SQLite store, ported from
//! `apps/daemon/src/tool-result-mcp.ts`, `apps/daemon/src/tool-result-store.ts`, and
//! `apps/daemon/src/measurement-correlation.ts`.
//!
//! Uses `ace-store`'s cached prepared statements on one SQLite connection (ADR 0222):
//! - `observe_start` runs the 90s prior-item lookup, concurrent-invocation ambiguity check, and
//!   row insert inside one `BEGIN IMMEDIATE` transaction.
//! - `observe_finish` stores the captured JSON result, image hashes, and runs `correlate_result`.
//! - `correlate_item` binds late-arriving `ace_tools` rows within the 5s window.
//! - `lease_ended` marks unbound rows for that session as ambiguous (`bound_id = ''`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ace_json::{Map, Value};
use ace_store::{Connection, Error as StoreError, Value as SqlValue, stmt_cache};
use sha2::{Digest as _, Sha256};

use crate::tool_names::bare_tool_name;

const PRIOR_WINDOW_MS: i64 = 90_000;
const LATE_ITEM_WINDOW_MS: i64 = 5_000;

/// Canonical JSON + SHA-256 hex key for tool arguments so provider envelopes and MCP HTTP
/// requests with different object key orderings correlate (`measurement-correlation.ts:24`).
pub fn argument_key(value: &Value) -> String {
    let canonical = canonical_value(value);
    let json = ace_json::to_string(&canonical);
    let digest = Sha256::digest(json.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Null => Value::Object(Map::new()),
        Value::Array(items) => {
            let mapped: Vec<Value> = items.iter().map(canonical_nested).collect();
            Value::Array(mapped.into())
        }
        Value::Object(map) => canonical_object(map),
        other => other.clone(),
    }
}

fn canonical_nested(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            let mapped: Vec<Value> = items.iter().map(canonical_nested).collect();
            Value::Array(mapped.into())
        }
        Value::Object(map) => canonical_object(map),
        other => other.clone(),
    }
}

fn canonical_object(map: &Map) -> Value {
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));
    let mut out = Map::with_capacity(entries.len());
    for (k, v) in entries {
        out.insert(k.clone(), canonical_nested(v));
    }
    Value::Object(out)
}

/// Parameters for starting a tracked MCP call (`observeCall`).
#[derive(Debug, Clone)]
pub struct CallStart<'a> {
    pub result_id: &'a str,
    pub thread_id: &'a str,
    pub agent_id: &'a str,
    pub session_id: &'a str,
    pub called_name: &'a str,
    pub redacted_input: &'a Value,
    pub started_ms: i64,
    pub since_seq: i64,
}

/// Parameters for finishing a tracked MCP call.
#[derive(Debug, Clone)]
pub struct CallFinish<'a> {
    pub result_id: &'a str,
    pub thread_id: &'a str,
    pub result_json: &'a str,
    pub finished_ms: i64,
    pub notice_id: Option<&'a str>,
    pub image_hashes: &'a [&'a str],
}

/// A provider tool-call item row recorded in `ace_tools`.
#[derive(Debug, Clone)]
pub struct AceToolRow<'a> {
    pub item_id: &'a str,
    pub thread_id: &'a str,
    pub agent_id: &'a str,
    pub bare_name: &'a str,
    pub args_key: &'a str,
    pub seq: i64,
    pub started_ms: i64,
    pub status: &'a str,
}

/// A result row that was newly bound to its provider `ace_tools` item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrelatedBinding {
    pub result_id: String,
    pub thread_id: String,
    pub item_id: String,
    pub notice_id: Option<String>,
}

/// SQLite-backed call record and correlation engine (`ace_tools`, `ace_results`, `ace_result_images`).
pub struct CallRecords {
    conn: Arc<Connection>,
    leases: Mutex<HashMap<String, i64>>,
}

impl CallRecords {
    pub fn new(conn: Arc<Connection>) -> Self {
        Self {
            conn,
            leases: Mutex::new(HashMap::new()),
        }
    }

    /// Create the `ace_tools`, `ace_results`, and `ace_result_images` tables and indexes matching
    /// `apps/daemon/src/tool-result-store.ts`.
    pub fn ensure_schema(&self) -> Result<(), StoreError> {
        self.conn.exec(
            "CREATE TABLE IF NOT EXISTS ace_tools (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                name TEXT NOT NULL,
                args TEXT NOT NULL,
                seq INTEGER NOT NULL,
                started INTEGER NOT NULL,
                status TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ace_tool_match
                ON ace_tools(thread_id, agent_id, name, args, seq);
            CREATE TABLE IF NOT EXISTS ace_results (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                args TEXT NOT NULL,
                started INTEGER NOT NULL,
                finished INTEGER,
                since_seq INTEGER NOT NULL,
                item_id TEXT UNIQUE,
                bound_id TEXT,
                result JSON,
                notice_id TEXT
            );
            CREATE INDEX IF NOT EXISTS ace_result_pending
                ON ace_results(thread_id, agent_id, name, args, finished)
                WHERE item_id IS NULL;
            CREATE INDEX IF NOT EXISTS ace_result_session
                ON ace_results(session_id, name, args)
                WHERE item_id IS NULL;
            CREATE TABLE IF NOT EXISTS ace_result_images (
                result_id TEXT NOT NULL REFERENCES ace_results(id) ON DELETE CASCADE,
                thread_id TEXT NOT NULL,
                hash TEXT NOT NULL,
                PRIMARY KEY(result_id, hash)
            );
            CREATE INDEX IF NOT EXISTS ace_result_image
                ON ace_result_images(thread_id, hash);",
        )
    }

    /// Record the starting store head sequence for a session lease.
    pub fn lease_started(&self, session_id: &str, head_seq: i64) {
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        leases.insert(session_id.to_owned(), head_seq);
    }

    /// End a session lease and mark any still-unbound rows from it ambiguous (`bound_id = ''`).
    pub fn lease_ended(&self, session_id: &str) -> Result<(), StoreError> {
        {
            let mut leases = self
                .leases
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            leases.remove(session_id);
        }
        stmt_cache::run(
            &self.conn,
            "UPDATE ace_results SET bound_id='' WHERE session_id=? AND item_id IS NULL AND bound_id IS NULL",
            vec![SqlValue::Text(session_id.to_owned())],
        )?;
        Ok(())
    }

    /// Upsert a provider's MCP tool-call item into `ace_tools` (`ToolResultStore::decorate`).
    pub fn upsert_tool_item(&self, row: &AceToolRow<'_>) -> Result<(), StoreError> {
        stmt_cache::run(
            &self.conn,
            "INSERT INTO ace_tools VALUES(?,?,?,?,?,?,?,?) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, args=excluded.args, status=excluded.status",
            vec![
                SqlValue::Text(row.item_id.to_owned()),
                SqlValue::Text(row.thread_id.to_owned()),
                SqlValue::Text(row.agent_id.to_owned()),
                SqlValue::Text(row.bare_name.to_owned()),
                SqlValue::Text(row.args_key.to_owned()),
                SqlValue::Integer(row.seq),
                SqlValue::Integer(row.started_ms),
                SqlValue::Text(row.status.to_owned()),
            ],
        )?;
        Ok(())
    }

    /// Record the start of an MCP tool call in one transaction, preserving the 90s prior-item
    /// lookup and concurrent-invocation ambiguity rules (`tool-result-mcp.ts:175`–`:227`).
    pub fn observe_start(&self, call: &CallStart<'_>) -> Result<(), StoreError> {
        let name = bare_tool_name(call.called_name);
        let key = argument_key(call.redacted_input);
        let lease_seq = {
            let leases = self
                .leases
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            leases
                .get(call.session_id)
                .copied()
                .unwrap_or(call.since_seq)
        };

        self.in_tx(|| {
            let prior = stmt_cache::all_rows_raw(
                &self.conn,
                "SELECT id FROM ace_tools t \
                 WHERE thread_id=? AND agent_id=? AND name=? AND args=? AND seq>? \
                 AND started BETWEEN ? AND ? AND status IN ('pending','running','awaiting_approval') \
                 AND NOT EXISTS(SELECT 1 FROM ace_results r WHERE r.item_id=t.id OR r.bound_id=t.id) \
                 LIMIT 2",
                vec![
                    SqlValue::Text(call.thread_id.to_owned()),
                    SqlValue::Text(call.agent_id.to_owned()),
                    SqlValue::Text(name.to_owned()),
                    SqlValue::Text(key.clone()),
                    SqlValue::Integer(lease_seq),
                    SqlValue::Integer(call.started_ms - PRIOR_WINDOW_MS),
                    SqlValue::Integer(call.started_ms),
                ],
            )?;

            let overlapping = stmt_cache::get_row_raw(
                &self.conn,
                "SELECT 1 FROM ace_results WHERE session_id=? AND name=? AND args=? AND finished IS NULL LIMIT 1",
                vec![
                    SqlValue::Text(call.session_id.to_owned()),
                    SqlValue::Text(name.to_owned()),
                    SqlValue::Text(key.clone()),
                ],
            )?
            .is_some();

            if overlapping {
                stmt_cache::run(
                    &self.conn,
                    "UPDATE ace_results SET bound_id='' WHERE session_id=? AND name=? AND args=? AND item_id IS NULL",
                    vec![
                        SqlValue::Text(call.session_id.to_owned()),
                        SqlValue::Text(name.to_owned()),
                        SqlValue::Text(key.clone()),
                    ],
                )?;
            }

            let bound_id = if overlapping || prior.len() > 1 {
                SqlValue::Text(String::new())
            } else if let Some(first) = prior.first()
                && let Some(SqlValue::Text(id)) = first.first()
            {
                SqlValue::Text(id.clone())
            } else {
                SqlValue::Null
            };

            stmt_cache::run(
                &self.conn,
                "INSERT INTO ace_results(id,thread_id,agent_id,session_id,name,args,started,since_seq,bound_id) \
                 VALUES(?,?,?,?,?,?,?,?,?)",
                vec![
                    SqlValue::Text(call.result_id.to_owned()),
                    SqlValue::Text(call.thread_id.to_owned()),
                    SqlValue::Text(call.agent_id.to_owned()),
                    SqlValue::Text(call.session_id.to_owned()),
                    SqlValue::Text(name.to_owned()),
                    SqlValue::Text(key),
                    SqlValue::Integer(call.started_ms),
                    SqlValue::Integer(call.since_seq),
                    bound_id,
                ],
            )?;
            Ok(())
        })
    }

    /// Record a call's finish payload, retained image hashes, and attempt correlation in one
    /// transaction (`tool-result-mcp.ts:256`–`:298`).
    pub fn observe_finish(
        &self,
        finish: &CallFinish<'_>,
    ) -> Result<Option<CorrelatedBinding>, StoreError> {
        self.in_tx(|| {
            stmt_cache::run(
                &self.conn,
                "UPDATE ace_results SET result=?,finished=?,notice_id=? WHERE id=?",
                vec![
                    SqlValue::Text(finish.result_json.to_owned()),
                    SqlValue::Integer(finish.finished_ms),
                    match finish.notice_id {
                        Some(id) => SqlValue::Text(id.to_owned()),
                        None => SqlValue::Null,
                    },
                    SqlValue::Text(finish.result_id.to_owned()),
                ],
            )?;
            for hash in finish.image_hashes {
                stmt_cache::run(
                    &self.conn,
                    "INSERT OR IGNORE INTO ace_result_images VALUES(?,?,?)",
                    vec![
                        SqlValue::Text(finish.result_id.to_owned()),
                        SqlValue::Text(finish.thread_id.to_owned()),
                        SqlValue::Text((*hash).to_owned()),
                    ],
                )?;
            }
            self.correlate_result_inner(finish.result_id)
        })
    }

    /// Bind pending finished results matching a newly-arrived provider tool-call item within the
    /// 5s late-arrival window (`tool-result-mcp.ts:150`–`:173`).
    pub fn correlate_item(
        &self,
        thread_id: &str,
        agent_id: &str,
        bare_name: &str,
        args_key: &str,
        now_ms: i64,
    ) -> Result<Vec<CorrelatedBinding>, StoreError> {
        let rows = stmt_cache::all_rows_raw(
            &self.conn,
            "SELECT id FROM ace_results \
             WHERE thread_id=? AND agent_id=? AND name=? AND args=? AND item_id IS NULL AND finished>=? \
             LIMIT 64",
            vec![
                SqlValue::Text(thread_id.to_owned()),
                SqlValue::Text(agent_id.to_owned()),
                SqlValue::Text(bare_name.to_owned()),
                SqlValue::Text(args_key.to_owned()),
                SqlValue::Integer(now_ms - LATE_ITEM_WINDOW_MS),
            ],
        )?;
        let mut bound = Vec::new();
        for row in rows {
            if let Some(SqlValue::Text(id)) = row.first()
                && let Some(binding) = self.in_tx(|| self.correlate_result_inner(id))?
            {
                bound.push(binding);
            }
        }
        Ok(bound)
    }

    /// Whether a thread's stored call results still reference image `hash`.
    pub fn retains_image(&self, thread_id: &str, hash: &str) -> Result<bool, StoreError> {
        Ok(stmt_cache::get_row_raw(
            &self.conn,
            "SELECT 1 FROM ace_result_images WHERE thread_id=? AND hash=? LIMIT 1",
            vec![
                SqlValue::Text(thread_id.to_owned()),
                SqlValue::Text(hash.to_owned()),
            ],
        )?
        .is_some())
    }

    fn correlate_result_inner(&self, id: &str) -> Result<Option<CorrelatedBinding>, StoreError> {
        let Some(row) = stmt_cache::get_row_raw(
            &self.conn,
            "SELECT thread_id, agent_id, name, args, started, finished, since_seq, bound_id, notice_id \
             FROM ace_results WHERE id=? AND item_id IS NULL AND result IS NOT NULL",
            vec![SqlValue::Text(id.to_owned())],
        )?
        else {
            return Ok(None);
        };

        let thread_id = text_at(&row, 0)?;
        let agent_id = text_at(&row, 1)?;
        let name = text_at(&row, 2)?;
        let args = text_at(&row, 3)?;
        let started = int_at(&row, 4)?;
        let finished = int_at(&row, 5)?;
        let since_seq = int_at(&row, 6)?;
        let bound_id = row.get(7);
        let notice_id = match row.get(8) {
            Some(SqlValue::Text(s)) => Some(s.clone()),
            _ => None,
        };

        if matches!(bound_id, Some(SqlValue::Text(s)) if s.is_empty()) {
            return Ok(None);
        }

        let candidates = match bound_id {
            Some(SqlValue::Null) | None => stmt_cache::all_rows_raw(
                &self.conn,
                "SELECT id FROM ace_tools t \
                 WHERE thread_id=? AND agent_id=? AND name=? AND args=? \
                 AND seq>? AND started BETWEEN ? AND ? \
                 AND NOT EXISTS(SELECT 1 FROM ace_results r WHERE r.item_id=t.id) \
                 LIMIT 2",
                vec![
                    SqlValue::Text(thread_id.clone()),
                    SqlValue::Text(agent_id),
                    SqlValue::Text(name),
                    SqlValue::Text(args),
                    SqlValue::Integer(since_seq),
                    SqlValue::Integer(started - PRIOR_WINDOW_MS),
                    SqlValue::Integer(finished + LATE_ITEM_WINDOW_MS),
                ],
            )?,
            Some(SqlValue::Text(bound)) => stmt_cache::all_rows_raw(
                &self.conn,
                "SELECT id FROM ace_tools t \
                 WHERE id=? AND NOT EXISTS(SELECT 1 FROM ace_results r WHERE r.item_id=t.id)",
                vec![SqlValue::Text(bound.clone())],
            )?,
            _ => return Ok(None),
        };

        if candidates.len() != 1 {
            return Ok(None);
        }
        let item_id = text_at(&candidates[0], 0)?;
        let (changed, _) = stmt_cache::run(
            &self.conn,
            "UPDATE ace_results SET item_id=? WHERE id=? AND item_id IS NULL",
            vec![
                SqlValue::Text(item_id.clone()),
                SqlValue::Text(id.to_owned()),
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(CorrelatedBinding {
            result_id: id.to_owned(),
            thread_id,
            item_id,
            notice_id,
        }))
    }

    fn in_tx<T>(&self, body: impl FnOnce() -> Result<T, StoreError>) -> Result<T, StoreError> {
        self.conn.exec("BEGIN IMMEDIATE")?;
        match body() {
            Ok(value) => {
                self.conn.exec("COMMIT")?;
                Ok(value)
            }
            Err(err) => {
                let _ = self.conn.exec("ROLLBACK");
                Err(err)
            }
        }
    }
}

fn text_at(row: &[SqlValue], idx: usize) -> Result<String, StoreError> {
    match row.get(idx) {
        Some(SqlValue::Text(s)) => Ok(s.clone()),
        _ => Err(StoreError {
            kind: ace_store::ErrorKind::Sqlite,
            code: 0,
            message: format!("expected text column at index {idx}"),
            errstr: String::new(),
        }),
    }
}

fn int_at(row: &[SqlValue], idx: usize) -> Result<i64, StoreError> {
    match row.get(idx) {
        Some(SqlValue::Integer(n)) => Ok(*n),
        _ => Err(StoreError {
            kind: ace_store::ErrorKind::Sqlite,
            code: 0,
            message: format!("expected integer column at index {idx}"),
            errstr: String::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_store::OpenOptions;

    fn open_records() -> (tempfile::TempDir, CallRecords) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let path = dir.path().join("store.sqlite");
        let conn = Connection::open(
            path.to_str().unwrap_or_default(),
            OpenOptions {
                read_only: false,
                timeout_ms: 5_000,
            },
        )
        .unwrap_or_else(|e| panic!("open sqlite: {e}"));
        let records = CallRecords::new(conn);
        records
            .ensure_schema()
            .unwrap_or_else(|e| panic!("schema: {e}"));
        (dir, records)
    }

    #[test]
    fn argument_key_is_independent_of_object_key_order() {
        let a = ace_json::parse("{\"b\":2,\"a\":{\"z\":1,\"y\":3}}").unwrap_or(Value::Null);
        let b = ace_json::parse("{\"a\":{\"y\":3,\"z\":1},\"b\":2}").unwrap_or(Value::Null);
        assert_eq!(argument_key(&a), argument_key(&b));
        assert_eq!(argument_key(&a).len(), 64);
    }

    #[test]
    fn a_single_prior_tool_item_within_ninety_seconds_binds_on_finish_and_retains_images() {
        let (_dir, records) = open_records();
        records.lease_started("sess-1", 10);
        let input = ace_json::parse("{\"url\":\"http://localhost:3000\"}").unwrap_or(Value::Null);
        let key = argument_key(&input);

        records
            .upsert_tool_item(&AceToolRow {
                item_id: "item-1",
                thread_id: "thread-1",
                agent_id: "agent-1",
                bare_name: "browser_open",
                args_key: &key,
                seq: 11,
                started_ms: 100_000,
                status: "running",
            })
            .unwrap_or_else(|e| panic!("{e}"));

        records
            .observe_start(&CallStart {
                result_id: "res-1",
                thread_id: "thread-1",
                agent_id: "agent-1",
                session_id: "sess-1",
                called_name: "mcp__ace__browser_open",
                redacted_input: &input,
                started_ms: 105_000,
                since_seq: 11,
            })
            .unwrap_or_else(|e| panic!("{e}"));

        let bound = records
            .observe_finish(&CallFinish {
                result_id: "res-1",
                thread_id: "thread-1",
                result_json: "{\"content\":[],\"isError\":false}",
                finished_ms: 106_000,
                notice_id: Some("notice-1"),
                image_hashes: &["abc123"],
            })
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            bound,
            Some(CorrelatedBinding {
                result_id: "res-1".to_owned(),
                thread_id: "thread-1".to_owned(),
                item_id: "item-1".to_owned(),
                notice_id: Some("notice-1".to_owned()),
            })
        );
        assert!(records.retains_image("thread-1", "abc123").unwrap_or(false));
        assert!(!records.retains_image("thread-1", "other").unwrap_or(true));
    }

    #[test]
    fn concurrent_identical_calls_clear_bound_id_so_neither_binds_ambiguously() {
        let (_dir, records) = open_records();
        records.lease_started("sess-1", 0);
        let input = ace_json::parse("{\"app\":\"Calculator\"}").unwrap_or(Value::Null);
        let key = argument_key(&input);

        records
            .upsert_tool_item(&AceToolRow {
                item_id: "item-a",
                thread_id: "thread-1",
                agent_id: "agent-1",
                bare_name: "screen_state",
                args_key: &key,
                seq: 1,
                started_ms: 10_000,
                status: "running",
            })
            .unwrap_or_else(|e| panic!("{e}"));

        records
            .observe_start(&CallStart {
                result_id: "res-a",
                thread_id: "thread-1",
                agent_id: "agent-1",
                session_id: "sess-1",
                called_name: "screen_state",
                redacted_input: &input,
                started_ms: 10_500,
                since_seq: 1,
            })
            .unwrap_or_else(|e| panic!("{e}"));

        // Second identical call starts before the first finishes -> both become ambiguous.
        records
            .observe_start(&CallStart {
                result_id: "res-b",
                thread_id: "thread-1",
                agent_id: "agent-1",
                session_id: "sess-1",
                called_name: "screen_state",
                redacted_input: &input,
                started_ms: 10_600,
                since_seq: 1,
            })
            .unwrap_or_else(|e| panic!("{e}"));

        let bound_a = records
            .observe_finish(&CallFinish {
                result_id: "res-a",
                thread_id: "thread-1",
                result_json: "{}",
                finished_ms: 11_000,
                notice_id: None,
                image_hashes: &[],
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let bound_b = records
            .observe_finish(&CallFinish {
                result_id: "res-b",
                thread_id: "thread-1",
                result_json: "{}",
                finished_ms: 11_100,
                notice_id: None,
                image_hashes: &[],
            })
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(bound_a, None);
        assert_eq!(bound_b, None);
    }

    #[test]
    fn late_arriving_tool_item_binds_within_five_seconds_unless_lease_already_ended() {
        let (_dir, records) = open_records();
        records.lease_started("sess-live", 5);
        let input = ace_json::parse("{\"topics\":[\"status\"]}").unwrap_or(Value::Null);
        let key = argument_key(&input);

        // Finish before item arrives.
        records
            .observe_start(&CallStart {
                result_id: "res-late",
                thread_id: "t1",
                agent_id: "a1",
                session_id: "sess-live",
                called_name: "context",
                redacted_input: &input,
                started_ms: 50_000,
                since_seq: 5,
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let on_finish = records
            .observe_finish(&CallFinish {
                result_id: "res-late",
                thread_id: "t1",
                result_json: "{\"ok\":true}",
                finished_ms: 51_000,
                notice_id: None,
                image_hashes: &[],
            })
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(on_finish, None);

        // Item arrives 2s later -> correlates cleanly.
        records
            .upsert_tool_item(&AceToolRow {
                item_id: "item-late",
                thread_id: "t1",
                agent_id: "a1",
                bare_name: "context",
                args_key: &key,
                seq: 6,
                started_ms: 52_000,
                status: "completed",
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let bindings = records
            .correlate_item("t1", "a1", "context", &key, 53_000)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].item_id, "item-late");

        // Ending a lease marks any unbound rows ambiguous so a later item never binds to them.
        records.lease_started("sess-ended", 6);
        records
            .observe_start(&CallStart {
                result_id: "res-orphan",
                thread_id: "t1",
                agent_id: "a1",
                session_id: "sess-ended",
                called_name: "context",
                redacted_input: &input,
                started_ms: 60_000,
                since_seq: 6,
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let _ = records
            .observe_finish(&CallFinish {
                result_id: "res-orphan",
                thread_id: "t1",
                result_json: "{}",
                finished_ms: 60_500,
                notice_id: None,
                image_hashes: &[],
            })
            .unwrap_or_else(|e| panic!("{e}"));
        records
            .lease_ended("sess-ended")
            .unwrap_or_else(|e| panic!("{e}"));
        records
            .upsert_tool_item(&AceToolRow {
                item_id: "item-after-end",
                thread_id: "t1",
                agent_id: "a1",
                bare_name: "context",
                args_key: &key,
                seq: 7,
                started_ms: 61_000,
                status: "completed",
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let after_end = records
            .correlate_item("t1", "a1", "context", &key, 61_500)
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(after_end.is_empty());
    }
}
