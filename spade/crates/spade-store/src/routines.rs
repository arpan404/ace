//! Routines and heartbeats (ADR 0129): standing work a bot does in its own conversation, and the
//! record of each run. A scheduled routine keeps its next slot; claiming a slot advances it and
//! records the run in one transaction, so a slot never runs twice, also across a restart.

use rusqlite::{OptionalExtension, Row, params};

use crate::{Result, Store};

/// `kind` of a heartbeat row; every other row is a `routine`.
pub const HEARTBEAT: &str = "heartbeat";
pub const ROUTINE: &str = "routine";
/// Runs kept per routine; older ones go as new ones are recorded.
const KEPT_RUNS: i64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRoutine {
    pub id: String,
    pub agent_id: String,
    /// [`ROUTINE`] or [`HEARTBEAT`]; an agent has at most one heartbeat.
    pub kind: String,
    pub name: String,
    pub instruction: String,
    /// The trigger as JSON (`spade_core::routine::Trigger`).
    pub trigger: String,
    /// The IANA time zone its schedule is read in.
    pub time_zone: String,
    pub paused: bool,
    /// The webhook's bearer, for a webhook routine.
    pub secret: Option<String>,
    /// The next slot of a scheduled routine; `None` for other triggers or a rule that ended.
    pub next_due_ms: Option<i64>,
    /// `person` or `agent`.
    pub created_by: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRun {
    pub id: String,
    pub routine_id: String,
    /// The schedule slot it ran for, when it had one.
    pub slot_ms: Option<i64>,
    pub at_ms: i64,
    /// `schedule`, `caught_up`, `event`, `webhook` or `manual`.
    pub cause: String,
    /// `pending` (claimed, not yet delivered), `delivered`, or `skipped_*`.
    pub outcome: String,
    /// The seq of its message in the bot's conversation, once delivered.
    pub seq: Option<i64>,
    /// Why it was skipped, or what the event was.
    pub detail: Option<String>,
}

const COLUMNS: &str = "id, agent_id, kind, name, instruction, trigger, time_zone, paused, secret,
    next_due_ms, created_by, created_ms, updated_ms";

fn routine(row: &Row<'_>) -> rusqlite::Result<StoredRoutine> {
    Ok(StoredRoutine {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        kind: row.get(2)?,
        name: row.get(3)?,
        instruction: row.get(4)?,
        trigger: row.get(5)?,
        time_zone: row.get(6)?,
        paused: row.get(7)?,
        secret: row.get(8)?,
        next_due_ms: row.get(9)?,
        created_by: row.get(10)?,
        created_ms: row.get(11)?,
        updated_ms: row.get(12)?,
    })
}

const RUN_COLUMNS: &str = "id, routine_id, slot_ms, at_ms, cause, outcome, seq, detail";

fn run(row: &Row<'_>) -> rusqlite::Result<StoredRun> {
    Ok(StoredRun {
        id: row.get(0)?,
        routine_id: row.get(1)?,
        slot_ms: row.get(2)?,
        at_ms: row.get(3)?,
        cause: row.get(4)?,
        outcome: row.get(5)?,
        seq: row.get(6)?,
        detail: row.get(7)?,
    })
}

impl Store {
    /// Stores a new routine. Returns false when the agent is gone or already has a heartbeat.
    pub fn insert_routine(&self, r: &StoredRoutine) -> Result<bool> {
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO routines (id, agent_id, kind, name, instruction, trigger,
                 time_zone, paused, secret, next_due_ms, created_by, created_ms, updated_ms)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
             WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?2)",
            params![
                r.id,
                r.agent_id,
                r.kind,
                r.name,
                r.instruction,
                r.trigger,
                r.time_zone,
                r.paused,
                r.secret,
                r.next_due_ms,
                r.created_by,
                r.created_ms,
                r.updated_ms
            ],
        )?;
        Ok(inserted == 1)
    }

    /// Writes every field of an existing routine but its id, agent, kind and creation. Returns
    /// whether it existed.
    pub fn update_routine(&self, r: &StoredRoutine) -> Result<bool> {
        let changed = self.lock()?.execute(
            "UPDATE routines SET name = ?2, instruction = ?3, trigger = ?4, time_zone = ?5,
                 paused = ?6, secret = ?7, next_due_ms = ?8, updated_ms = ?9
             WHERE id = ?1",
            params![
                r.id,
                r.name,
                r.instruction,
                r.trigger,
                r.time_zone,
                r.paused,
                r.secret,
                r.next_due_ms,
                r.updated_ms
            ],
        )?;
        Ok(changed == 1)
    }

    /// Deletes a routine and its runs. Returns whether it existed.
    pub fn delete_routine(&self, id: &str) -> Result<bool> {
        Ok(self
            .lock()?
            .execute("DELETE FROM routines WHERE id = ?1", params![id])?
            == 1)
    }

    pub fn routine(&self, id: &str) -> Result<Option<StoredRoutine>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM routines WHERE id = ?1"),
                params![id],
                routine,
            )
            .optional()?)
    }

    /// An agent's routines of `kind`, oldest first.
    pub fn routines_of(&self, agent_id: &str, kind: &str) -> Result<Vec<StoredRoutine>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM routines WHERE agent_id = ?1 AND kind = ?2
             ORDER BY created_ms, id"
        ))?;
        let rows = statement.query_map(params![agent_id, kind], routine)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every routine that is not paused, of every agent.
    pub fn active_routines(&self) -> Result<Vec<StoredRoutine>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM routines WHERE paused = 0 ORDER BY created_ms, id"
        ))?;
        let rows = statement.query_map([], routine)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Scheduled routines whose next slot is at or before `now_ms`, earliest first.
    pub fn due_routines(&self, now_ms: i64) -> Result<Vec<StoredRoutine>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM routines
             WHERE paused = 0 AND next_due_ms IS NOT NULL AND next_due_ms <= ?1
             ORDER BY next_due_ms, id"
        ))?;
        let rows = statement.query_map(params![now_ms], routine)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The earliest next slot of any active scheduled routine.
    pub fn next_routine_due(&self) -> Result<Option<i64>> {
        Ok(self.lock()?.query_row(
            "SELECT MIN(next_due_ms) FROM routines WHERE paused = 0 AND next_due_ms IS NOT NULL",
            [],
            |row| row.get(0),
        )?)
    }

    /// Records `run` and, for a scheduled firing, moves the routine's next slot from `slot` to
    /// `next`, together. Returns false, recording nothing, when the routine is gone, paused, or
    /// its next slot is no longer `slot` (another firing claimed it first).
    pub fn claim_run(
        &self,
        run: &StoredRun,
        slot: Option<Option<i64>>,
        next: Option<i64>,
    ) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let claimed = match slot {
            Some(slot) => tx.execute(
                "UPDATE routines SET next_due_ms = ?3
                 WHERE id = ?1 AND paused = 0 AND next_due_ms IS ?2",
                params![run.routine_id, slot, next],
            )?,
            None => tx.query_row(
                "SELECT COUNT(*) FROM routines WHERE id = ?1",
                params![run.routine_id],
                |row| {
                    row.get::<_, i64>(0)
                        .map(|n| usize::try_from(n).unwrap_or(0))
                },
            )?,
        };
        if claimed == 0 {
            return Ok(false);
        }
        tx.execute(
            &format!(
                "INSERT INTO routine_runs ({RUN_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
            ),
            params![
                run.id,
                run.routine_id,
                run.slot_ms,
                run.at_ms,
                run.cause,
                run.outcome,
                run.seq,
                run.detail
            ],
        )?;
        tx.execute(
            "DELETE FROM routine_runs WHERE routine_id = ?1 AND id NOT IN (
                 SELECT id FROM routine_runs WHERE routine_id = ?1
                 ORDER BY at_ms DESC, id DESC LIMIT ?2)",
            params![run.routine_id, KEPT_RUNS],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Marks a claimed run delivered at `seq`.
    pub fn run_delivered(&self, run: &str, seq: i64) -> Result<()> {
        self.lock()?.execute(
            "UPDATE routine_runs SET outcome = 'delivered', seq = ?2 WHERE id = ?1",
            params![run, seq],
        )?;
        Ok(())
    }

    /// Marks a claimed run as not delivered, saying why.
    pub fn run_skipped(&self, run: &str, outcome: &str, detail: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE routine_runs SET outcome = ?2, detail = ?3 WHERE id = ?1",
            params![run, outcome, detail],
        )?;
        Ok(())
    }

    /// Runs claimed but not yet delivered (Spade stopped in between), oldest first.
    pub fn pending_runs(&self) -> Result<Vec<StoredRun>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM routine_runs WHERE outcome = 'pending' ORDER BY at_ms, id"
        ))?;
        let rows = statement.query_map([], run)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// A routine's runs, newest first, at most `limit`.
    pub fn runs(&self, routine_id: &str, limit: usize) -> Result<Vec<StoredRun>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM routine_runs WHERE routine_id = ?1
             ORDER BY at_ms DESC, id DESC LIMIT ?2"
        ))?;
        let rows = statement.query_map(
            params![routine_id, i64::try_from(limit).unwrap_or(i64::MAX)],
            run,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// A routine's latest delivered run.
    pub fn last_delivered_run(&self, routine_id: &str) -> Result<Option<StoredRun>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                &format!(
                    "SELECT {RUN_COLUMNS} FROM routine_runs
                     WHERE routine_id = ?1 AND outcome IN ('delivered', 'pending')
                     ORDER BY at_ms DESC, id DESC LIMIT 1"
                ),
                params![routine_id],
                run,
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewAgent;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("temp dir: {e}"));
        let store = Store::open(&dir.path().join("spade.sqlite")).unwrap_or_else(|e| panic!("{e}"));
        store
            .create_agent(
                NewAgent {
                    id: "a_1",
                    kind: "bot",
                    name: "Scout",
                    task: "",
                    avatar: "{}",
                    model: "fake/m",
                    conversation: "c_1",
                },
                &[],
                1,
            )
            .unwrap_or_else(|e| panic!("{e}"));
        (dir, store)
    }

    fn briefing(next: Option<i64>) -> StoredRoutine {
        StoredRoutine {
            id: "rt_1".into(),
            agent_id: "a_1".into(),
            kind: ROUTINE.into(),
            name: "Briefing".into(),
            instruction: "Brief me.".into(),
            trigger: r#"{"kind":"schedule","schedule":"daily at 9:00"}"#.into(),
            time_zone: "UTC".into(),
            paused: false,
            secret: None,
            next_due_ms: next,
            created_by: "person".into(),
            created_ms: 1,
            updated_ms: 1,
        }
    }

    fn run(id: &str) -> StoredRun {
        StoredRun {
            id: id.into(),
            routine_id: "rt_1".into(),
            slot_ms: Some(100),
            at_ms: 100,
            cause: "schedule".into(),
            outcome: "pending".into(),
            seq: None,
            detail: None,
        }
    }

    #[test]
    fn a_slot_is_claimed_once_even_when_two_firings_race_for_it() -> Result<()> {
        let (_dir, store) = store();
        assert!(store.insert_routine(&briefing(Some(100)))?);
        assert!(store.claim_run(&run("run_1"), Some(Some(100)), Some(200))?);
        assert!(!store.claim_run(&run("run_2"), Some(Some(100)), Some(200))?);
        assert_eq!(
            store.routine("rt_1")?.and_then(|r| r.next_due_ms),
            Some(200)
        );
        assert_eq!(store.pending_runs()?.len(), 1);
        store.run_delivered("run_1", 7)?;
        assert!(store.pending_runs()?.is_empty());
        assert_eq!(store.runs("rt_1", 10)?[0].seq, Some(7));
        Ok(())
    }

    #[test]
    fn deleting_the_agent_deletes_its_routines_and_runs() -> Result<()> {
        let (_dir, store) = store();
        store.insert_routine(&briefing(Some(100)))?;
        store.claim_run(&run("run_1"), None, None)?;
        assert!(store.delete_agent("a_1")?);
        assert!(store.routine("rt_1")?.is_none());
        assert!(store.pending_runs()?.is_empty());
        Ok(())
    }

    #[test]
    fn an_agent_has_one_heartbeat_at_most() -> Result<()> {
        let (_dir, store) = store();
        let beat = |id: &str| StoredRoutine {
            id: id.into(),
            kind: HEARTBEAT.into(),
            ..briefing(None)
        };
        assert!(store.insert_routine(&beat("hb_1"))?);
        assert!(!store.insert_routine(&beat("hb_2"))?);
        Ok(())
    }
}
