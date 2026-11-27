// SPDX-License-Identifier: Apache-2.0
//! The automation store's schema and its bounded open-time migration, split from the queries.
//! The tables and columns are the TypeScript's; opening never rewrites run history (ADR 0170).

use ace_json::Value;
use ace_store::Value as SqlValue;
use serde::Serialize;

use super::AutomationStore;
use crate::error::{AutomationsError, Result};

const SCHEMA: &str = "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;
      CREATE TABLE IF NOT EXISTS automation_jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL, nominal INTEGER, due INTEGER, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_state(id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, automation_id TEXT NOT NULL, event_key TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, input TEXT, finished_at INTEGER, UNIQUE(automation_id,event_key));
      CREATE TABLE IF NOT EXISTS automation_poll_errors(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_trigger_errors(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_revisions(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_cancellations(run_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, reason TEXT NOT NULL, requested_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_webhooks(automation_id TEXT PRIMARY KEY, hook_id TEXT NOT NULL UNIQUE, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_webhook_deliveries(automation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, run_id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(automation_id, delivery_id));
      CREATE TABLE IF NOT EXISTS automation_migration(id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL);";

/// The indexes the TypeScript creates. They are added only with a table this build creates, so
/// opening a large existing home never indexes or rewrites history (ADR 0170).
const JOB_INDEXES: &str = "CREATE INDEX IF NOT EXISTS automation_due ON automation_jobs(due,id) WHERE due IS NOT NULL;
      CREATE INDEX IF NOT EXISTS automation_schedule_due ON automation_jobs(due,id) WHERE due IS NOT NULL AND json_extract(body,'$.trigger.kind')='schedule';";

const RUN_INDEXES: &str = "CREATE INDEX IF NOT EXISTS automation_history ON automation_runs(automation_id,seq);
      CREATE INDEX IF NOT EXISTS automation_active ON automation_runs(automation_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS automation_status ON automation_runs(status,seq);
      CREATE INDEX IF NOT EXISTS automation_unfinished ON automation_runs(seq) WHERE finished_at IS NULL;
      CREATE INDEX IF NOT EXISTS automation_finished ON automation_runs(coalesce(finished_at, 9007199254740991));";

const WEBHOOK_INDEXES: &str = "CREATE INDEX IF NOT EXISTS automation_webhook_expiry ON automation_webhook_deliveries(expires);";

pub(crate) fn number(value: i64) -> Value {
    Value::Number(value.into())
}

pub(crate) fn text(value: &str) -> Value {
    Value::String(value.into())
}

pub(crate) fn text_of(value: &str) -> Option<SqlValue> {
    Some(SqlValue::Text(value.to_owned()))
}

pub(crate) fn int_of(value: Option<i64>) -> Option<SqlValue> {
    Some(value.map_or(SqlValue::Null, SqlValue::Integer))
}

pub(crate) fn row_int(row: &[SqlValue], index: usize) -> Option<i64> {
    match row.get(index) {
        Some(SqlValue::Integer(value)) => Some(*value),
        _ => None,
    }
}

pub(crate) fn row_text(row: &[SqlValue], index: usize) -> Option<&str> {
    match row.get(index) {
        Some(SqlValue::Text(value)) => Some(value),
        _ => None,
    }
}

pub(crate) fn parse_json(text: &str) -> Result<Value> {
    ace_json::parse(text).map_err(|error| AutomationsError::message(error.to_string()))
}

pub(crate) fn serialize<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    ace_json::ser::to_string(value).map_err(|error| AutomationsError::message(error.to_string()))
}

pub(crate) fn ensure_schema(store: &AutomationStore) -> Result<()> {
    let jobs_existed = table_exists(store, "automation_jobs")?;
    let runs_existed = table_exists(store, "automation_runs")?;
    let webhooks_existed = table_exists(store, "automation_webhook_deliveries")?;
    store.conn.exec(SCHEMA)?;
    // A column added before any index reads it; the table may have been written by an older
    // build. The ALTER is constant-time.
    let columns = store.query("PRAGMA table_info(automation_runs)", &[])?;
    if !columns
        .iter()
        .any(|column| row_text(column, 1) == Some("finished_at"))
    {
        store
            .conn
            .exec("ALTER TABLE automation_runs ADD COLUMN finished_at INTEGER")?;
    }
    if !jobs_existed {
        store.conn.exec(JOB_INDEXES)?;
    }
    if !runs_existed {
        store.conn.exec(RUN_INDEXES)?;
    }
    if !webhooks_existed {
        store.conn.exec(WEBHOOK_INDEXES)?;
    }
    // Bounded by the automation limit (1,000 jobs), never by run history. `finished_at` rows
    // are backfilled separately in bounded idle batches (`backfill_finished_at`).
    store.transaction(|| {
        store.conn.exec(
            "INSERT OR IGNORE INTO automation_state SELECT id,state FROM automation_jobs;
             UPDATE automation_jobs SET state='{}' WHERE state<>'{}';
             INSERT OR IGNORE INTO automation_revisions SELECT id,1 FROM automation_jobs;",
        )?;
        Ok(())
    })
}

/// Create the run indexes an older home may lack. Called from idle, never from open, because
/// indexing an existing history is work proportional to it (ADR 0170).
pub(crate) fn ensure_run_indexes(store: &AutomationStore) -> Result<()> {
    store.conn.exec(RUN_INDEXES)?;
    Ok(())
}

fn table_exists(store: &AutomationStore, name: &str) -> Result<bool> {
    Ok(!store
        .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            &[Some(SqlValue::Text(name.to_owned()))],
        )?
        .is_empty())
}
