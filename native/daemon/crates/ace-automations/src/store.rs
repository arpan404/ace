// SPDX-License-Identifier: Apache-2.0
//! The durable side of the scheduler, ported from `packages/automations/src/store.ts`. Both
//! daemons open the same file through `ace-store`'s connection factory, with today's tables,
//! columns and JSON: `automation_jobs` holds the definition and its cursor, `automation_state`
//! the poll/schedule snapshot, `automation_revisions` the CAS counter, and the run tables the
//! history and cancellations. Opening never rewrites history (ADR 0170).

use std::cell::Cell;
use std::sync::Arc;

use ace_json::{Map, Value};
use ace_store::{Connection, OpenOptions, Value as SqlValue};

use crate::error::{AutomationsError, Result};
use crate::store_schema::{
    int_of, number, parse_json, row_int, row_text, serialize, text, text_of,
};

pub use crate::definition::{Definition, ScheduleTrigger, Trigger, TriggerError};

/// `Number.MAX_SAFE_INTEGER` (`store.ts:51`): where runs still going sort in the finished index.
pub const NOT_FINISHED: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub struct JobMetadata {
    pub automation: Definition,
    pub nominal: Option<i64>,
    pub due: Option<i64>,
    pub revision: i64,
    pub last_poll_error: Option<Value>,
    pub trigger_error: Option<TriggerError>,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub metadata: JobMetadata,
    pub state: Value,
}

/// What one admission produced: the run record, its status, whether it was admitted now and
/// whether the claim created the row.
#[derive(Debug, Clone)]
pub struct ClaimedRun {
    pub run: Value,
    pub status: String,
    pub admitted: bool,
    pub created: bool,
}

/// The fields one admission is keyed by (`store.ts:421`).
pub struct Claim<'a> {
    pub event_key: &'a str,
    pub trigger: &'a str,
    pub id: &'a str,
    pub now: i64,
    pub input: Option<&'a Value>,
    pub failure: Option<&'a str>,
    pub skip: Option<&'a str>,
}

pub struct AutomationStore {
    pub(crate) conn: Arc<Connection>,
    pub(crate) depth: Cell<u32>,
    /// Where the bounded `finished_at` backfill resumes, and how many rows it last examined.
    /// The cursor is persisted in `automation_migration`, so a restart resumes rather than
    /// re-reading history from the start.
    idle_cursor: Cell<i64>,
    idle_complete: Cell<bool>,
    idle_examined: Cell<usize>,
    /// The index state read from `sqlite_master`, cached until this store repairs or builds it.
    finished_index: Cell<Option<FinishedIndex>>,
}

/// Which `automation_finished` the file holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishedIndex {
    Missing,
    /// The TypeScript's `Number.MAX_SAFE_INTEGER` expression.
    Current,
    /// A build's older `i64::MAX` expression; queries cannot use it.
    Outdated,
}

/// Rebuilding over more rows than this is left to an explicit maintenance call; idle drops the
/// bad index instead (a constant-time repair) and the inbox scans until then.
const REBUILD_INDEX_ROWS: i64 = 10_000;

/// The running rows start-up recovers, and the waiting automations it drains. Both are written so
/// a home without `automation_status` can answer them through the partial indexes.
const ACTIVE_RUNS_SQL: &str =
    "SELECT body,input FROM automation_runs WHERE status='running' ORDER BY seq LIMIT 256";
const ACTIVE_RUNS_INDEX_SQL: &str = "SELECT body,input FROM automation_runs INDEXED BY automation_active WHERE status='running' ORDER BY seq LIMIT 256";
const WAITING_RUNS_SQL: &str = "SELECT automation_id AS aid FROM automation_runs WHERE finished_at IS NULL AND status='queued' GROUP BY automation_id ORDER BY MIN(seq) LIMIT 1000";
const WAITING_RUNS_INDEX_SQL: &str = "SELECT automation_id AS aid FROM automation_runs INDEXED BY automation_unfinished WHERE finished_at IS NULL AND status='queued' GROUP BY automation_id ORDER BY MIN(seq) LIMIT 1000";

/// Every index over run history. A home written before one of them existed gets it in idle on a
/// small file, each checked on its own.
const RUN_INDEX_NAMES: [&str; 5] = [
    "automation_history",
    "automation_active",
    "automation_status",
    "automation_unfinished",
    "automation_finished",
];

impl AutomationStore {
    pub fn open(path: &str) -> Result<AutomationStore> {
        let conn = Connection::open(
            path,
            OpenOptions {
                read_only: false,
                timeout_ms: 5000,
            },
        )?;
        let store = AutomationStore {
            conn,
            depth: Cell::new(0),
            idle_cursor: Cell::new(0),
            idle_complete: Cell::new(false),
            idle_examined: Cell::new(0),
            finished_index: Cell::new(None),
        };
        store.ensure_schema()?;
        let (cursor, complete) = store.load_migration()?;
        store.idle_cursor.set(cursor);
        store.idle_complete.set(complete);
        Ok(store)
    }

    pub fn close(&self) -> Result<()> {
        self.conn.close()?;
        Ok(())
    }

    fn ensure_schema(&self) -> Result<()> {
        super::store_schema::ensure_schema(self)
    }

    pub(crate) fn query(
        &self,
        sql: &str,
        params: &[Option<SqlValue>],
    ) -> Result<Vec<Vec<SqlValue>>> {
        let statement = self.conn.prepare(sql)?;
        statement.bind(params)?;
        let mut rows = Vec::new();
        while let Some(row) = statement.step()? {
            rows.push(row);
        }
        Ok(rows)
    }

    pub(crate) fn execute(&self, sql: &str, params: &[Option<SqlValue>]) -> Result<()> {
        self.execute_changes(sql, params).map(|_| ())
    }

    /// Like [`AutomationStore::execute`], returning how many rows the statement changed.
    pub(crate) fn execute_changes(&self, sql: &str, params: &[Option<SqlValue>]) -> Result<usize> {
        let statement = self.conn.prepare(sql)?;
        statement.bind(params)?;
        let _ = statement.step()?;
        let (changes, _) = statement.changes()?;
        Ok(changes.max(0) as usize)
    }

    /// Start-up's query, named to the partial index that bounds it when the home has one.
    fn startup_sql(&self, waiting: bool) -> Result<&'static str> {
        if waiting {
            Ok(if self.has_index("automation_unfinished")? {
                WAITING_RUNS_INDEX_SQL
            } else {
                WAITING_RUNS_SQL
            })
        } else {
            Ok(if self.has_index("automation_active")? {
                ACTIVE_RUNS_INDEX_SQL
            } else {
                ACTIVE_RUNS_SQL
            })
        }
    }

    /// The query plan start-up uses for running rows, or for waiting automations when `waiting`.
    /// A legacy home without `automation_status` must still answer both from a partial index.
    pub fn startup_query_plan(&self, waiting: bool) -> Result<Vec<String>> {
        let sql = self.startup_sql(waiting)?;
        Ok(self
            .query(&format!("EXPLAIN QUERY PLAN {sql}"), &[])?
            .iter()
            .filter_map(|row| row_text(row, 3).map(str::to_owned))
            .collect())
    }

    /// Whether the named index exists in this file.
    pub fn has_index(&self, name: &str) -> Result<bool> {
        Ok(!self
            .query(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
                &[text_of(name)],
            )?
            .is_empty())
    }

    /// The `automation_finished` expression this file holds, read from its SQL once.
    pub fn finished_index(&self) -> Result<FinishedIndex> {
        if let Some(state) = self.finished_index.get() {
            return Ok(state);
        }
        let state = self.read_finished_index()?;
        self.finished_index.set(Some(state));
        Ok(state)
    }

    fn read_finished_index(&self) -> Result<FinishedIndex> {
        let rows = self.query(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='automation_finished'",
            &[],
        )?;
        let Some(sql) = rows.first().and_then(|row| row_text(row, 0)) else {
            return Ok(FinishedIndex::Missing);
        };
        if sql.contains("9007199254740991") && !sql.contains("9223372036854775807") {
            Ok(FinishedIndex::Current)
        } else {
            Ok(FinishedIndex::Outdated)
        }
    }

    /// One bounded append of the `finished_at` backfill (`store.ts:92`), keyed by `seq` so each
    /// call reads at most `limit` rows and holds the write lock for at most `limit` updates.
    /// Rows written by the TypeScript or an older build otherwise read as unfinished forever.
    pub fn backfill_finished_at(&self, limit: usize) -> Result<usize> {
        self.idle_examined.set(0);
        if limit == 0 || self.idle_complete.get() {
            return Ok(0);
        }
        self.repair_run_indexes()?;
        let limit = limit.min(i64::MAX as usize) as i64;
        let rows = self.query(
            "SELECT seq,json_extract(body,'$.finishedAt') FROM automation_runs WHERE seq > ? ORDER BY seq LIMIT ?",
            &[
                Some(SqlValue::Integer(self.idle_cursor.get())),
                Some(SqlValue::Integer(limit)),
            ],
        )?;
        self.idle_examined.set(rows.len());
        if rows.is_empty() {
            self.idle_complete.set(true);
            self.save_migration()?;
            return Ok(0);
        }
        let mut changed = 0;
        self.transaction(|| {
            for row in &rows {
                let (Some(seq), Some(finished)) = (row_int(row, 0), row_int(row, 1)) else {
                    continue;
                };
                changed += self.execute_changes(
                    "UPDATE automation_runs SET finished_at=? WHERE seq=? AND finished_at IS NULL",
                    &[
                        Some(SqlValue::Integer(finished)),
                        Some(SqlValue::Integer(seq)),
                    ],
                )?;
            }
            Ok(())
        })?;
        if let Some(last) = rows.last().and_then(|row| row_int(row, 0)) {
            self.idle_cursor.set(last);
        }
        self.save_migration()?;
        Ok(changed)
    }

    fn load_migration(&self) -> Result<(i64, bool)> {
        Ok(self
            .query(
                "SELECT cursor,complete FROM automation_migration WHERE id=1",
                &[],
            )?
            .first()
            .map(|row| {
                (
                    row_int(row, 0).unwrap_or(0),
                    row_int(row, 1).unwrap_or(0) != 0,
                )
            })
            .unwrap_or((0, false)))
    }

    fn save_migration(&self) -> Result<()> {
        self.execute(
            "INSERT INTO automation_migration VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor, complete=excluded.complete",
            &[
                Some(SqlValue::Integer(self.idle_cursor.get())),
                Some(SqlValue::Integer(i64::from(self.idle_complete.get()))),
            ],
        )
    }

    /// Rows the last [`AutomationStore::backfill_finished_at`] examined, for the bounded-work
    /// test and the host's idle metrics.
    pub fn idle_examined(&self) -> usize {
        self.idle_examined.get()
    }

    /// Heal the run indexes without history-sized work: a small file (the TypeScript's old
    /// homes included) gets every run index here; a large one only drops an unusable
    /// `automation_finished` and leaves the rebuild to
    /// [`AutomationStore::create_run_indexes`], with the inbox's indexed path falling back.
    fn repair_run_indexes(&self) -> Result<()> {
        let state = self.finished_index()?;
        let mut missing = false;
        for name in RUN_INDEX_NAMES {
            if !self.has_index(name)? {
                missing = true;
                break;
            }
        }
        if state == FinishedIndex::Current && !missing {
            return Ok(());
        }
        if self.runs_over_threshold()? {
            if state == FinishedIndex::Outdated {
                self.execute("DROP INDEX automation_finished", &[])?;
                self.finished_index.set(Some(FinishedIndex::Missing));
            }
            return Ok(());
        }
        if state == FinishedIndex::Outdated {
            self.execute("DROP INDEX automation_finished", &[])?;
        }
        crate::store_schema::ensure_run_indexes(self)?;
        self.finished_index.set(Some(self.read_finished_index()?));
        Ok(())
    }

    /// Whether the file holds more runs than idle may index, read in a bounded probe: at most
    /// 10,001 rows, never a `COUNT(*)` over the whole history.
    fn runs_over_threshold(&self) -> Result<bool> {
        let rows = self
            .query(
                "SELECT COUNT(*) FROM (SELECT 1 FROM automation_runs LIMIT 10001)",
                &[],
            )?
            .first()
            .and_then(|row| row_int(row, 0))
            .unwrap_or(0);
        Ok(rows > REBUILD_INDEX_ROWS)
    }

    /// Build every run index in one write. History-sized by nature: the host's explicit
    /// maintenance call for a file over the idle threshold, never open or idle.
    pub fn create_run_indexes(&self) -> Result<()> {
        crate::store_schema::ensure_run_indexes(self)?;
        self.finished_index.set(Some(self.read_finished_index()?));
        Ok(())
    }

    /// One commit for `operation`; a transaction opened inside it joins the outer one.
    pub fn transaction<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.depth.get() > 0 {
            return operation();
        }
        self.conn.exec("BEGIN IMMEDIATE")?;
        self.depth.set(1);
        let result = operation();
        self.depth.set(0);
        match result {
            Ok(value) => {
                self.conn.exec("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                self.conn.exec("ROLLBACK")?;
                Err(error)
            }
        }
    }

    pub fn revision(&self, id: &str) -> Result<Option<i64>> {
        Ok(self
            .query(
                "SELECT revision FROM automation_revisions WHERE id=?",
                &[text_of(id)],
            )?
            .first()
            .and_then(|row| row_int(row, 0)))
    }

    /// `put` (`store.ts:143`): create, update or compare-and-swap one definition and its cursor.
    pub fn put(
        &self,
        automation: &Definition,
        nominal: Option<i64>,
        due: Option<i64>,
        state: &Value,
        expected_revision: Option<Option<i64>>,
    ) -> Result<i64> {
        let body = serialize(&automation.normalized()?)?;
        let snapshot = ace_json::to_string(state);
        let revision = self.transaction(|| {
      let stored_revision = self.revision(&automation.id)?;
      let live = !self
        .query(
          "SELECT 1 AS found FROM automation_jobs WHERE id=?",
          &[text_of(&automation.id)],
        )?
        .is_empty();
      match expected_revision {
        Some(None) if live => {
          return Err(AutomationsError::message("Automation already exists"));
        }
        Some(None) => {}
        Some(Some(expected)) => {
          if !live {
            return Err(AutomationsError::message("Automation is missing"));
          }
          if stored_revision != Some(expected) {
            return Err(AutomationsError::message("Automation revision conflict"));
          }
        }
        None => {}
      }
      if !live {
        let count = self
          .query("SELECT COUNT(*) AS n FROM automation_jobs", &[])?
          .first()
          .and_then(|row| row_int(row, 0))
          .unwrap_or(0);
        if count >= 1000 {
          return Err(AutomationsError::message("Automation limit reached"));
        }
      }
      let next = stored_revision.unwrap_or(0) + 1;
      self.execute(
        "INSERT INTO automation_jobs VALUES(?,?,?,?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, nominal=excluded.nominal, due=excluded.due, state=excluded.state",
        &[
          text_of(&automation.id),
          text_of(&body),
          int_of(nominal),
          int_of(due),
          text_of("{}"),
        ],
      )?;
      if automation.trigger.kind() != "github" {
        self.clear_poll_error(&automation.id)?;
      }
      if automation.trigger.kind() != "webhook" {
        self.forget_webhook(&automation.id)?;
      }
      if automation.trigger.kind() != "file" {
        self.clear_trigger_error(&automation.id)?;
      }
      self.execute(
        "INSERT INTO automation_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
        &[text_of(&automation.id), text_of(&snapshot)],
      )?;
      self.execute(
        "INSERT INTO automation_revisions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
        &[text_of(&automation.id), Some(SqlValue::Integer(next))],
      )?;
      Ok(next)
    })?;
        Ok(revision)
    }

    /// `remove` (`store.ts:191`): null and omitted stay idempotent; a number enforces CAS, the
    /// tombstone included.
    pub fn remove(&self, id: &str, expected_revision: Option<Option<i64>>) -> Result<()> {
        self.transaction(|| {
      let stored_revision = self.revision(id)?;
      let live = !self
        .query(
          "SELECT 1 AS found FROM automation_jobs WHERE id=?",
          &[text_of(id)],
        )?
        .is_empty();
      match expected_revision {
        Some(Some(expected)) => {
          if stored_revision != Some(expected) {
            return Err(AutomationsError::message("Automation revision conflict"));
          }
          if !live {
            return Ok(());
          }
        }
        _ => {
          if !live {
            return Ok(());
          }
        }
      }
      self.clear_poll_error(id)?;
      self.clear_trigger_error(id)?;
      self.forget_webhook(id)?;
      self.execute("DELETE FROM automation_state WHERE id=?", &[text_of(id)])?;
      self.execute("DELETE FROM automation_jobs WHERE id=?", &[text_of(id)])?;
      self.execute(
        "INSERT INTO automation_revisions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
        &[
          text_of(id),
          Some(SqlValue::Integer(stored_revision.unwrap_or(0) + 1)),
        ],
      )?;
      Ok(())
    })
    }

    /// Reads `id, nominal, body, poll error, trigger error, due, revision`, the column order
    /// every metadata query below selects.
    fn read_metadata(&self, row: &[SqlValue]) -> Result<JobMetadata> {
        let body = row_text(row, 2).ok_or_else(|| AutomationsError::message("Row has no body"))?;
        let definition = Definition::normalize(&parse_json(body)?)?;
        let poll = row_text(row, 3).map(parse_json).transpose()?;
        let trigger = match row_text(row, 4) {
            Some(text) => Some(ace_json::from_value(&parse_json(text)?)?),
            None => None,
        };
        Ok(JobMetadata {
            automation: definition,
            nominal: row_int(row, 1),
            due: row_int(row, 5),
            revision: row_int(row, 6).unwrap_or(1),
            last_poll_error: poll,
            trigger_error: trigger,
        })
    }

    pub fn metadata(&self, id: &str) -> Result<Option<JobMetadata>> {
        let rows = self.query(
      "SELECT j.id,j.nominal,j.body,e.body,t.body,j.due,coalesce(r.revision,1) FROM automation_jobs j LEFT JOIN automation_revisions r ON r.id=j.id LEFT JOIN automation_poll_errors e ON e.id=j.id LEFT JOIN automation_trigger_errors t ON t.id=j.id WHERE j.id=?",
      &[text_of(id)],
    )?;
        match rows.first() {
            Some(row) => Ok(Some(self.read_metadata(row)?)),
            None => Ok(None),
        }
    }

    pub fn get(&self, id: &str) -> Result<Option<Job>> {
        let Some(metadata) = self.metadata(id)? else {
            return Ok(None);
        };
        Ok(Some(Job {
            metadata,
            state: self.read_state(id)?,
        }))
    }

    pub fn definition(&self, id: &str) -> Result<Option<Definition>> {
        let rows = self.query(
            "SELECT body FROM automation_jobs WHERE id=?",
            &[text_of(id)],
        )?;
        match rows.first() {
            Some(row) => {
                let body =
                    row_text(row, 0).ok_or_else(|| AutomationsError::message("Row has no body"))?;
                Ok(Some(Definition::normalize(&parse_json(body)?)?))
            }
            None => Ok(None),
        }
    }

    pub fn read_state(&self, id: &str) -> Result<Value> {
        let rows = self.query(
            "SELECT state FROM automation_state WHERE id=?",
            &[text_of(id)],
        )?;
        match rows.first() {
            Some(row) => {
                let state = row_text(row, 0)
                    .ok_or_else(|| AutomationsError::message("Row has no state"))?;
                parse_json(state)
            }
            None => Err(AutomationsError::message("Automation is missing")),
        }
    }

    /// Every automation this build can read; one it can't is told to `unreadable` and passed
    /// over, never taking down the rest.
    pub fn jobs(
        &self,
        mut unreadable: impl FnMut(&str, &AutomationsError),
    ) -> Result<Vec<JobMetadata>> {
        let rows = self.query(
      "SELECT j.id,j.nominal,j.body,e.body,t.body,j.due,coalesce(r.revision,1) FROM automation_jobs j LEFT JOIN automation_revisions r ON r.id=j.id LEFT JOIN automation_poll_errors e ON e.id=j.id LEFT JOIN automation_trigger_errors t ON t.id=j.id ORDER BY j.id LIMIT 1001",
      &[],
    )?;
        if rows.len() > 1000 {
            return Err(AutomationsError::message("Automation limit exceeded"));
        }
        let mut jobs = Vec::with_capacity(rows.len());
        for row in &rows {
            let id = row_text(row, 0).unwrap_or("").to_owned();
            match self.read_metadata(row) {
                Ok(job) => jobs.push(job),
                Err(error) => unreadable(&id, &error),
            }
        }
        Ok(jobs)
    }

    pub fn list(&self) -> Result<Vec<JobMetadata>> {
        self.jobs(|_, _| {})
    }

    fn first_readable(&self, ids: &[String]) -> Result<Option<JobMetadata>> {
        for id in ids {
            // A row this build can't read is kept and passed over, so it never keeps the next one
            // from its deadline.
            if let Ok(Some(job)) = self.metadata(id) {
                return Ok(Some(job));
            }
        }
        Ok(None)
    }

    fn due_ids(&self, scheduled_only: bool) -> Result<Vec<String>> {
        let sql = if scheduled_only {
            "SELECT id FROM automation_jobs WHERE due IS NOT NULL AND json_extract(body,'$.trigger.kind')='schedule' ORDER BY due,id LIMIT 1001"
        } else {
            "SELECT id FROM automation_jobs WHERE due IS NOT NULL ORDER BY due,id LIMIT 1001"
        };
        Ok(self
            .query(sql, &[])?
            .iter()
            .filter_map(|row| row_text(row, 0).map(str::to_owned))
            .collect())
    }

    /// The readable automation due first (`store.ts:314`).
    pub fn next(&self, excluded: &[String]) -> Result<Option<JobMetadata>> {
        if excluded.len() > 4 {
            return Err(AutomationsError::message("Too many excluded polls"));
        }
        let all = self.due_ids(false)?;
        let ids: Vec<String> = all
            .into_iter()
            .filter(|id| !excluded.contains(id))
            .collect();
        self.first_readable(&ids)
    }

    /// The readable automation due first that is not skipped (`store.ts:318`).
    pub fn next_skipping(
        &self,
        skip: &std::collections::HashSet<String>,
    ) -> Result<Option<JobMetadata>> {
        let ids: Vec<String> = self
            .due_ids(false)?
            .into_iter()
            .filter(|id| !skip.contains(id))
            .collect();
        self.first_readable(&ids)
    }

    /// The readable due schedule first.
    pub fn next_scheduled(&self) -> Result<Option<JobMetadata>> {
        let ids = self.due_ids(true)?;
        self.first_readable(&ids)
    }

    /// The readable due schedule first that is not skipped (`store.ts:328`).
    pub fn next_scheduled_skipping(
        &self,
        skip: &std::collections::HashSet<String>,
    ) -> Result<Option<JobMetadata>> {
        let ids: Vec<String> = self
            .due_ids(true)?
            .into_iter()
            .filter(|id| !skip.contains(id))
            .collect();
        self.first_readable(&ids)
    }

    /// The earliest due deadline, readable or not, for arming one timer.
    pub fn earliest_due(&self) -> Result<Option<i64>> {
        Ok(self
            .query(
                "SELECT due FROM automation_jobs WHERE due IS NOT NULL ORDER BY due,id LIMIT 1",
                &[],
            )?
            .first()
            .and_then(|row| row_int(row, 0)))
    }

    pub fn advance(&self, id: &str, nominal: Option<i64>, due: Option<i64>) -> Result<()> {
        self.execute(
            "UPDATE automation_jobs SET nominal=?,due=? WHERE id=?",
            &[int_of(nominal), int_of(due), text_of(id)],
        )
    }

    pub fn save_state(&self, id: &str, state: &Value) -> Result<()> {
        self.execute(
            "UPDATE automation_state SET state=? WHERE id=?",
            &[text_of(&ace_json::to_string(state)), text_of(id)],
        )
    }

    /// `savePoll` (`store.ts:340`), the name the service uses.
    pub fn save_poll(&self, id: &str, state: &Value) -> Result<()> {
        self.save_state(id, state)
    }

    pub fn save_poll_error(&self, id: &str, error: &Value) -> Result<()> {
        self.execute(
      "INSERT INTO automation_poll_errors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      &[text_of(id), text_of(&ace_json::to_string(error))],
    )
    }

    pub fn clear_poll_error(&self, id: &str) -> Result<()> {
        self.execute(
            "DELETE FROM automation_poll_errors WHERE id=?",
            &[text_of(id)],
        )
    }

    pub fn save_trigger_error(&self, id: &str, error: &Value) -> Result<()> {
        self.execute(
      "INSERT INTO automation_trigger_errors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      &[text_of(id), text_of(&ace_json::to_string(error))],
    )
    }

    pub fn clear_trigger_error(&self, id: &str) -> Result<()> {
        self.execute(
            "DELETE FROM automation_trigger_errors WHERE id=?",
            &[text_of(id)],
        )
    }

    /// Set an automation's hook id and sealed secret, keeping its hook id when it has one.
    pub fn webhook_rotate(
        &self,
        automation_id: &str,
        hook_id: &str,
        sealed: &str,
    ) -> Result<String> {
        self.execute(
      "INSERT INTO automation_webhooks VALUES(?,?,?) ON CONFLICT(automation_id) DO UPDATE SET secret=excluded.secret",
      &[text_of(automation_id), text_of(hook_id), text_of(sealed)],
    )?;
        Ok(self
            .webhook_hook(automation_id)?
            .unwrap_or_else(|| hook_id.to_owned()))
    }

    /// An automation's hook id, when it has a webhook.
    pub fn webhook_hook(&self, automation_id: &str) -> Result<Option<String>> {
        Ok(self
            .query(
                "SELECT hook_id FROM automation_webhooks WHERE automation_id=?",
                &[text_of(automation_id)],
            )?
            .first()
            .and_then(|row| row_text(row, 0))
            .map(str::to_owned))
    }

    /// A hook's automation and sealed secret, unless it isn't a hook.
    pub fn webhook_by_hook(&self, hook_id: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .query(
                "SELECT automation_id, secret FROM automation_webhooks WHERE hook_id=?",
                &[text_of(hook_id)],
            )?
            .first()
            .and_then(|row| Some((row_text(row, 0)?.to_owned(), row_text(row, 1)?.to_owned()))))
    }

    /// The run a delivery started, kept apart from run history (`webhook-store.ts:57`).
    pub fn webhook_delivered(
        &self,
        automation_id: &str,
        event_key: &str,
    ) -> Result<Option<String>> {
        Ok(
      self
        .query(
          "SELECT run_id FROM automation_webhook_deliveries WHERE automation_id=? AND delivery_id=?",
          &[text_of(automation_id), text_of(event_key)],
        )?
        .first()
        .and_then(|row| row_text(row, 0))
        .map(str::to_owned),
    )
    }

    /// Note a delivery's run until `expires`, dropping a bounded batch of expired receipts first.
    pub fn webhook_deliver(
        &self,
        automation_id: &str,
        event_key: &str,
        run_id: &str,
        expires: i64,
        now: i64,
    ) -> Result<()> {
        self.execute(
      "DELETE FROM automation_webhook_deliveries WHERE rowid IN (SELECT rowid FROM automation_webhook_deliveries WHERE expires < ? ORDER BY expires LIMIT 64)",
      &[Some(SqlValue::Integer(now))],
    )?;
        self.execute(
            "INSERT OR IGNORE INTO automation_webhook_deliveries VALUES(?,?,?,?)",
            &[
                text_of(automation_id),
                text_of(event_key),
                text_of(run_id),
                Some(SqlValue::Integer(expires)),
            ],
        )
    }

    pub fn forget_webhook(&self, id: &str) -> Result<()> {
        self.execute(
            "DELETE FROM automation_webhooks WHERE automation_id=?",
            &[text_of(id)],
        )?;
        self.execute(
            "DELETE FROM automation_webhook_deliveries WHERE automation_id=?",
            &[text_of(id)],
        )
    }

    /// Catalog reads need names, never prompt bodies, scheduling state or run history.
    pub fn catalog(&self, provider: &str, workspace: &str) -> Result<Vec<(String, String)>> {
        let rows = self.query(
      "SELECT id, json_extract(body,'$.title') AS title, json_extract(body,'$.enabled') AS enabled, json_extract(body,'$.workspace') AS workspace, json_extract(body,'$.provider') AS provider FROM automation_jobs ORDER BY id LIMIT 1000",
      &[],
    )?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let id = row_text(row, 0)?;
                let title = row_text(row, 1)?;
                let enabled = row_int(row, 2)? == 1;
                let row_workspace = row_text(row, 3)?;
                let row_provider = row_text(row, 4)?;
                (enabled && row_provider == provider && row_workspace == workspace)
                    .then(|| (id.to_owned(), title.to_owned()))
            })
            .take(128)
            .collect())
    }

    /// `claim` (`store.ts:421`): one run per event key, subject to admission.
    pub fn claim(&self, automation: &Definition, claim: &Claim<'_>) -> Result<ClaimedRun> {
        let existing = self.query(
            "SELECT body FROM automation_runs WHERE automation_id=? AND event_key=?",
            &[text_of(&automation.id), text_of(claim.event_key)],
        )?;
        if let Some(row) = existing.first() {
            let body =
                row_text(row, 0).ok_or_else(|| AutomationsError::message("Run has no body"))?;
            let run = parse_json(body)?;
            let status = match &run {
                Value::Object(map) => map
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                _ => String::new(),
            };
            return Ok(ClaimedRun {
                run,
                status,
                admitted: false,
                created: false,
            });
        }
        let active = self.count(
            "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id=? AND status='running'",
            Some(&automation.id),
        )?;
        let total = self.count(
            "SELECT COUNT(*) AS n FROM automation_runs WHERE status='running'",
            None,
        )?;
        let waiting = self.queued(&automation.id)?;
        let status = if claim.failure.is_some() {
            "failed"
        } else if claim.input.is_none() || claim.skip.is_some() {
            "skipped"
        } else {
            crate::decisions::admission(active, waiting, total, claim.trigger == "file")
        };
        let admitted = status == "running";
        let queued = status == "queued";
        let mut run = Map::new();
        run.insert("id", text(claim.id));
        run.insert("automationId", text(&automation.id));
        run.insert("title", text(&automation.title));
        run.insert("eventKey", text(claim.event_key));
        run.insert("trigger", text(claim.trigger));
        run.insert("status", text(status));
        run.insert("startedAt", number(claim.now));
        if !admitted && !queued {
            run.insert("finishedAt", number(claim.now));
            let result = claim.failure.or(claim.skip).unwrap_or(if waiting {
                "A run was already waiting"
            } else {
                "Too many automations running"
            });
            run.insert("result", text(result));
        }
        let run = Value::Object(run);
        if claim.trigger == "file" && status == "skipped" {
            return Ok(ClaimedRun {
                run,
                status: status.to_owned(),
                admitted: false,
                created: false,
            });
        }
        self.execute(
      "INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,?,?)",
      &[
        text_of(claim.id),
        text_of(&automation.id),
        text_of(claim.event_key),
        text_of(status),
        text_of(&ace_json::to_string(&run)),
        claim
          .input
          .map(|input| SqlValue::Text(ace_json::to_string(input))),
        if admitted || queued {
          Some(SqlValue::Null)
        } else {
          Some(SqlValue::Integer(claim.now))
        },
      ],
    )?;
        if claim.trigger == "webhook" {
            self.webhook_deliver(
                &automation.id,
                claim.event_key,
                claim.id,
                claim.now + 2 * crate::webhook_signature::WEBHOOK_TOLERANCE_MS,
                claim.now,
            )?;
        }
        self.prune(&automation.id)?;
        Ok(ClaimedRun {
            run,
            status: status.to_owned(),
            admitted,
            created: true,
        })
    }

    fn count(&self, sql: &str, id: Option<&str>) -> Result<usize> {
        let rows = match id {
            Some(id) => self.query(sql, &[text_of(id)])?,
            None => self.query(sql, &[])?,
        };
        Ok(rows
            .first()
            .and_then(|row| row_int(row, 0))
            .unwrap_or(0)
            .max(0) as usize)
    }

    /// The query plan for [`AutomationStore::inbox`] with a finish time, through the same
    /// index decision the inbox makes.
    pub fn inbox_query_plan(&self, finished_after: i64) -> Result<Vec<String>> {
        let where_clause = vec![
            "seq < ?".to_owned(),
            format!("coalesce(finished_at, {NOT_FINISHED}) > ?"),
        ];
        let values = vec![
            Some(SqlValue::Integer(NOT_FINISHED)),
            Some(SqlValue::Integer(finished_after)),
        ];
        let indexed = self.finished_index()? == FinishedIndex::Current;
        let (sql, values) = inbox_query(50, &where_clause, values, indexed);
        Ok(self
            .query(&format!("EXPLAIN QUERY PLAN {sql}"), &values)?
            .iter()
            .filter_map(|row| row_text(row, 3).map(str::to_owned))
            .collect())
    }

    /// The stored run count, for the scheduler's admission tests and future listings.
    pub fn run_count(&self) -> Result<usize> {
        self.count("SELECT COUNT(*) AS n FROM automation_runs", None)
    }

    pub fn running(&self, id: &str) -> Result<bool> {
        Ok(!self
            .query(
                "SELECT 1 FROM automation_runs WHERE automation_id=? AND status='running' LIMIT 1",
                &[text_of(id)],
            )?
            .is_empty())
    }

    pub fn queued(&self, id: &str) -> Result<bool> {
        Ok(!self
            .query(
                "SELECT 1 FROM automation_runs WHERE automation_id=? AND status='queued' LIMIT 1",
                &[text_of(id)],
            )?
            .is_empty())
    }

    pub fn waiting_automations(&self) -> Result<Vec<String>> {
        // `finished_at IS NULL` lets a home without `automation_status` answer this through the
        // unfinished partial index instead of scanning run history at start-up.
        Ok(self
            .query(self.startup_sql(true)?, &[])?
            .iter()
            .filter_map(|row| row_text(row, 0).map(str::to_owned))
            .collect())
    }

    /// Stop an automation's work in the transaction that pauses or deletes it (`store.ts:538`):
    /// waiting runs are skipped and running runs get a durable cancellation.
    pub fn halt(&self, id: &str, now: i64, reason: &str) -> Result<Vec<Value>> {
        self.transaction(|| {
      self.execute(
        "INSERT OR IGNORE INTO automation_cancellations SELECT id,automation_id,?,? FROM automation_runs WHERE automation_id=? AND status='running'",
        &[text_of(reason), Some(SqlValue::Integer(now)), text_of(id)],
      )?;
      self.drop_queued(id, now, reason)
    })
    }

    /// Skip every waiting run of this automation, saying why.
    pub fn drop_queued(&self, id: &str, now: i64, reason: &str) -> Result<Vec<Value>> {
        let rows = self.query(
            "SELECT id,body FROM automation_runs WHERE automation_id=? AND status='queued'",
            &[text_of(id)],
        )?;
        let mut skipped = Vec::with_capacity(rows.len());
        for row in &rows {
            let Some(run_id) = row_text(row, 0) else {
                continue;
            };
            let Some(body) = row_text(row, 1) else {
                continue;
            };
            let mut run = parse_json(body)?;
            if let Value::Object(map) = &mut run {
                map.insert("status", text("skipped"));
                map.insert("finishedAt", number(now));
                map.insert("result", text(reason));
            }
            self.execute(
        "UPDATE automation_runs SET status='skipped',body=?,finished_at=? WHERE id=? AND status='queued'",
        &[
          text_of(&ace_json::to_string(&run)),
          Some(SqlValue::Integer(now)),
          text_of(run_id),
        ],
      )?;
            skipped.push(run);
        }
        Ok(skipped)
    }

    /// Why a running run was cancelled, while its cancellation is still being carried out.
    pub fn cancellation(&self, run_id: &str) -> Result<Option<String>> {
        Ok(self
            .query(
                "SELECT reason FROM automation_cancellations WHERE run_id=?",
                &[text_of(run_id)],
            )?
            .first()
            .and_then(|row| row_text(row, 0))
            .map(str::to_owned))
    }

    /// Running runs whose cancellation is not carried out yet, for start-up to send again.
    pub fn cancelling(&self) -> Result<Vec<(Value, Value)>> {
        let rows = self.query(
      "SELECT r.body,r.input FROM automation_cancellations c JOIN automation_runs r ON r.id=c.run_id WHERE r.status='running' LIMIT 256",
      &[],
    )?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let body = parse_json(row_text(row, 0)?).ok()?;
                let input = parse_json(row_text(row, 1)?).ok()?;
                Some((body, input))
            })
            .collect())
    }

    /// Running runs this build can read, oldest first. The running partial index answers this
    /// even on a legacy home without `automation_status`.
    pub fn active(&self) -> Result<Vec<(Value, Value)>> {
        let rows = self.query(self.startup_sql(false)?, &[])?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let body = parse_json(row_text(row, 0)?).ok()?;
                let input = parse_json(row_text(row, 1)?).ok()?;
                Some((body, input))
            })
            .collect())
    }

    /// Start this automation's oldest waiting run once nothing of it is running (`store.ts:497`).
    pub fn promote(&self, automation: &Definition, now: i64) -> Result<Option<(Value, Value)>> {
        let active = self.count(
            "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id=? AND status='running'",
            Some(&automation.id),
        )?;
        let total = self.count(
            "SELECT COUNT(*) AS n FROM automation_runs WHERE status='running'",
            None,
        )?;
        if !crate::decisions::can_promote(active, total) {
            return Ok(None);
        }
        let rows = self.query(
      "SELECT id,body,input FROM automation_runs WHERE automation_id=? AND status='queued' ORDER BY seq LIMIT 1",
      &[text_of(&automation.id)],
    )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let Some(run_id) = row_text(row, 0) else {
            return Ok(None);
        };
        let Some(body) = row_text(row, 1) else {
            return Ok(None);
        };
        let Some(input) = row_text(row, 2) else {
            return Ok(None);
        };
        let mut run = parse_json(body)?;
        if let Value::Object(map) = &mut run {
            map.insert("status", text("running"));
            map.insert("startedAt", number(now));
        }
        self.execute(
            "UPDATE automation_runs SET status='running',body=? WHERE id=? AND status='queued'",
            &[text_of(&ace_json::to_string(&run)), text_of(run_id)],
        )?;
        Ok(Some((run, parse_json(input)?)))
    }

    /// Settle a running run with its executor's outcome (`store.ts:567`).
    pub fn finish(
        &self,
        run_id: &str,
        now: i64,
        status: &str,
        thread_id: Option<&str>,
        result: Option<&str>,
    ) -> Result<Option<Value>> {
        self.transaction(|| {
            let rows = self.query(
                "SELECT body FROM automation_runs WHERE id=? AND status='running'",
                &[text_of(run_id)],
            )?;
            let Some(row) = rows.first() else {
                return Ok(None);
            };
            let Some(body) = row_text(row, 0) else {
                return Ok(None);
            };
            let mut run = parse_json(body)?;
            let automation_id = match &run {
                Value::Object(map) => map
                    .get("automationId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                _ => String::new(),
            };
            if let Value::Object(map) = &mut run {
                map.insert("status", text(status));
                if let Some(thread_id) = thread_id {
                    map.insert("threadId", text(thread_id));
                }
                if let Some(result) = result {
                    map.insert("result", text(result));
                }
                map.insert("finishedAt", number(now));
            }
            self.execute(
        "UPDATE automation_runs SET status=?,body=?,finished_at=? WHERE id=? AND status='running'",
        &[
          text_of(status),
          text_of(&ace_json::to_string(&run)),
          Some(SqlValue::Integer(now)),
          text_of(run_id),
        ],
      )?;
            self.execute(
                "DELETE FROM automation_cancellations WHERE run_id=?",
                &[text_of(run_id)],
            )?;
            self.prune(&automation_id)?;
            Ok(Some(run))
        })
    }

    /// One page of run history, newest first (`store.ts:631`).
    pub fn inbox(
        &self,
        limit: usize,
        before: Option<i64>,
        automation_id: Option<&str>,
        finished_after: Option<i64>,
    ) -> Result<(Vec<Value>, Option<i64>)> {
        let limit = limit.clamp(1, 100);
        let mut where_clause = vec!["seq < ?".to_owned()];
        let mut values: Vec<Option<SqlValue>> =
            vec![Some(SqlValue::Integer(before.unwrap_or(NOT_FINISHED)))];
        if let Some(automation_id) = automation_id {
            where_clause.push("automation_id=?".to_owned());
            values.push(text_of(automation_id));
        }
        if let Some(finished_after) = finished_after {
            where_clause.push(format!("coalesce(finished_at, {NOT_FINISHED}) > ?"));
            values.push(Some(SqlValue::Integer(finished_after)));
        }
        let indexed = finished_after.is_some() && self.finished_index()? == FinishedIndex::Current;
        let (sql, values) = inbox_query(limit, &where_clause, values, indexed);
        let rows = self.query(&sql, &values)?;
        let mut runs = Vec::new();
        for row in rows.iter().take(limit) {
            if let Some(body) = row_text(row, 1) {
                runs.push(parse_json(body)?);
            }
        }
        let next = if rows.len() > limit {
            rows.get(limit - 1).and_then(|row| row_int(row, 0))
        } else {
            None
        };
        Ok((runs, next))
    }

    /// One indexed lookup per live automation, without scanning run history.
    pub fn latest_runs(&self) -> Result<Vec<(String, Value)>> {
        let rows = self.query(
      "SELECT j.id AS aid, (SELECT r.body FROM automation_runs r WHERE r.automation_id=j.id ORDER BY r.seq DESC LIMIT 1) AS runBody FROM automation_jobs j ORDER BY j.id LIMIT 1001",
      &[],
    )?;
        let mut runs = Vec::new();
        for row in &rows {
            let (Some(id), Some(body)) = (row_text(row, 0), row_text(row, 1)) else {
                continue;
            };
            if let Ok(run) = parse_json(body) {
                runs.push((id.to_owned(), run));
            }
        }
        Ok(runs)
    }

    /// The execution input stored with a run, for recovery that finds nothing sent.
    pub fn run_input(&self, run_id: &str) -> Result<Option<Value>> {
        let rows = self.query(
            "SELECT input FROM automation_runs WHERE id=?",
            &[text_of(run_id)],
        )?;
        match rows.first().and_then(|row| row_text(row, 0)) {
            Some(input) => Ok(Some(parse_json(input)?)),
            None => Ok(None),
        }
    }

    pub fn latest_run(&self, automation_id: &str) -> Result<Option<Value>> {
        let rows = self.query(
            "SELECT body FROM automation_runs WHERE automation_id=? ORDER BY seq DESC LIMIT 1",
            &[text_of(automation_id)],
        )?;
        match rows.first().and_then(|row| row_text(row, 0)) {
            Some(body) => Ok(Some(parse_json(body)?)),
            None => Ok(None),
        }
    }

    fn prune(&self, id: &str) -> Result<()> {
        self.execute(
      "DELETE FROM automation_runs WHERE automation_id=? AND status NOT IN ('running','queued') AND seq NOT IN (SELECT seq FROM automation_runs WHERE automation_id=? ORDER BY seq DESC LIMIT 1000)",
      &[text_of(id), text_of(id)],
    )
    }
}

/// `store.ts:652`: with a finish time, the query names the finished index so the planner never
/// walks every settled run backwards.
fn inbox_query(
    limit: usize,
    where_clause: &[String],
    mut values: Vec<Option<SqlValue>>,
    finished_after: bool,
) -> (String, Vec<Option<SqlValue>>) {
    values.push(Some(SqlValue::Integer(limit as i64 + 1)));
    let from = if finished_after {
        "automation_runs INDEXED BY automation_finished"
    } else {
        "automation_runs"
    };
    (
        format!(
            "SELECT seq,body FROM {from} WHERE {} ORDER BY seq DESC LIMIT ?",
            where_clause.join(" AND ")
        ),
        values,
    )
}
