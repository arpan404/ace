// SPDX-License-Identifier: Apache-2.0
//! Owned groups recorded by pid, kernel start and owner in a small SQLite
//! journal, so the next start or `ace stop` can stop exactly them. Ports
//! `process-inventory.ts`: rows, deletes retried on a bounded backoff, and
//! the capacity bound. Recovery lives in `recover.rs`.

#[cfg(not(windows))]
use crate::entries::{INVENTORY_CAPACITY, OwnerValue};
use crate::entries::{ProcessEntry, entry_json, parse_entry};
use crate::errors::SupervisorError;
use crate::identity::ProcessIdentity;
#[cfg(not(windows))]
use crate::identity::ProcessOwner;
use crate::retry::{GuardedTick, inventory_backoff_ms};
use ace_store::{Connection, OpenOptions, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Why a liveness probe refused to say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeRefused {
    /// The kernel refused the probe; keep the record for a later recovery.
    Refused,
    /// Anything else: startup stays fail-closed.
    Failed(String),
}

/// What the inventory asks of the world, with fakes in tests.
pub trait InventoryRuntime {
    /// Kernel identity of a pid; `None` once it is gone. Throws when the
    /// kernel won't say, which proves nothing either way.
    fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError>;
    /// Non-consuming proof that an owned child exited before being reaped.
    fn child_exited(&self, pid: u32) -> bool;
    /// Whether this process's own just-spawned child answers a pid probe
    /// (unreaped, so its pid is pinned): gone, refused, or failed.
    fn alive(&self, pid: u32) -> Result<bool, ProbeRefused>;
    /// Whether a recorded leader still runs as itself: its pid shows
    /// `start`. An identity check only; no group is ever probed.
    fn leader_alive(&self, pid: u32, start: &str) -> Result<bool, ProbeRefused>;
    /// One process-table snapshot for the pass: live members by group, and
    /// whether every candidate was read. Answered per row, never re-listed
    /// per row.
    fn group_snapshot(&self) -> crate::system::GroupSnapshot;
    /// Ends a verified group whose leader started at `start`.
    fn kill(&self, group: u32, start: &str);
    /// This process: the owner recorded rows name.
    fn owner_pid(&self) -> u32;
    /// Milliseconds now, for the retry backoff.
    fn now_ms(&self) -> u64;
}

/// What `retry_removals` decided: nothing left, or another attempt later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryPlan {
    /// Every delete landed; the timer, if any, is cancelled.
    Done,
    /// Another attempt in this many milliseconds.
    RetryIn(u64),
}

/// The process inventory over `path`, opened through the store's connection
/// so one SQLite library touches the file.
pub struct Inventory<R> {
    pub(crate) db: Arc<Connection>,
    pub(crate) runtime: R,
    report: Arc<dyn Fn(String) + Send + Sync>,
    pub(crate) unremoved: HashSet<u32>,
    /// Recovery's first empty scans: pid to (group, first empty `now_ms`).
    /// A row whose leader is gone is forgotten only after two empty scans at
    /// least a second apart; the retry pass takes the second scan.
    pub(crate) empty_since: HashMap<u32, (u32, u64)>,
    tick: GuardedTick,
    pub(crate) retry_at_ms: Option<u64>,
    closed: bool,
    /// Windows only: when the descendant recorder is next due.
    #[cfg(windows)]
    windows_due_ms: Option<u64>,
}

impl<R: InventoryRuntime> Inventory<R> {
    /// Opens (creating) the journal. Every spawn and exit writes here on
    /// the main thread; WAL commits are durable when the daemon crashes.
    pub fn open(
        path: &str,
        runtime: R,
        report: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, SupervisorError> {
        let db = Connection::open(path, OpenOptions::default())
            .map_err(|error| SupervisorError::journal("inventory open", error))?;
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|error| SupervisorError::journal("inventory pragmas", error))?;
        db.exec(
            "CREATE TABLE IF NOT EXISTS processes(pid INTEGER PRIMARY KEY,entry TEXT NOT NULL)",
        )
        .map_err(|error| SupervisorError::journal("inventory schema", error))?;
        Ok(Self {
            db,
            runtime,
            report,
            unremoved: HashSet::new(),
            empty_since: HashMap::new(),
            tick: GuardedTick::new(),
            retry_at_ms: None,
            closed: false,
            #[cfg(windows)]
            windows_due_ms: None,
        })
    }

    /// The runtime the inventory reads the kernel through.
    pub fn runtime(&self) -> &R {
        &self.runtime
    }

    fn count(&self) -> Result<i64, SupervisorError> {
        query_one(&self.db, "SELECT COUNT(*) AS n FROM processes", &[])
    }

    pub(crate) fn write(
        &self,
        entry: &ProcessEntry,
        platform: crate::entries::EntryPlatform,
    ) -> Result<(), SupervisorError> {
        let statement = self
            .db
            .prepare("INSERT INTO processes VALUES (?,?) ON CONFLICT(pid) DO UPDATE SET entry=excluded.entry")
            .map_err(|error| SupervisorError::journal("inventory write", error))?;
        statement
            .bind(&[
                Some(Value::Integer(entry.pid as i64)),
                Some(Value::Text(entry_json(entry, platform))),
            ])
            .map_err(|error| SupervisorError::journal("inventory write", error))?;
        drain(&statement, "inventory write")
    }

    /// Every recorded process, by pid.
    pub fn list(&self) -> Result<Vec<ProcessEntry>, SupervisorError> {
        let statement = self
            .db
            .prepare("SELECT entry FROM processes ORDER BY pid")
            .map_err(|error| SupervisorError::journal("inventory list", error))?;
        statement
            .bind(&[])
            .map_err(|error| SupervisorError::journal("inventory list", error))?;
        let mut entries = Vec::new();
        while let Some(row) = statement
            .step()
            .map_err(|error| SupervisorError::journal("inventory list", error))?
        {
            let Value::Text(text) = &row[0] else {
                return Err(SupervisorError::Journal(
                    "inventory row is not text".to_owned(),
                ));
            };
            entries.push(parse_entry(text)?);
        }
        Ok(entries)
    }

    /// Records one owned leader. A reused pid: the earlier process's pending
    /// delete must not remove the new row.
    pub fn add(&mut self, pid: u32, name: &str, cwd: Option<&str>) -> Result<(), SupervisorError> {
        let now_ms = self.runtime.now_ms();
        self.unremoved.remove(&pid);
        self.empty_since.remove(&pid);
        self.retry_removals(now_ms);
        if name.chars().count() > 256 {
            return Err(SupervisorError::InvalidInput(
                "Cannot record owned process identity".to_owned(),
            ));
        }
        #[cfg(windows)]
        let added = self.windows_add(pid, name, cwd);
        #[cfg(not(windows))]
        let added = self.posix_add(pid, name, cwd);
        added
    }

    #[cfg(not(windows))]
    fn posix_add(
        &mut self,
        pid: u32,
        name: &str,
        cwd: Option<&str>,
    ) -> Result<(), SupervisorError> {
        let now_ms = self.runtime.now_ms();
        let identity = self.runtime.identity(pid)?;
        let owner_pid = self.runtime.owner_pid();
        let owner = self.runtime.identity(owner_pid)?;
        if identity.is_none()
            && (self.runtime.child_exited(pid)
                || !self
                    .runtime
                    .alive(pid)
                    .map_err(|refused| ProbeRefused::into_error(refused, pid))?)
        {
            return Ok(());
        }
        let (Some(identity), Some(owner)) = (identity, owner) else {
            return Err(SupervisorError::InvalidInput(
                "Cannot record owned process identity".to_owned(),
            ));
        };
        if identity.pid != pid
            || owner.pid != owner_pid
            || identity.group != pid
            || identity.owner != owner.owner
        {
            return Err(SupervisorError::InvalidInput(
                "Cannot record owned process identity".to_owned(),
            ));
        }
        if self.count()? >= INVENTORY_CAPACITY {
            return Err(SupervisorError::Limit(
                "Process inventory capacity".to_owned(),
            ));
        }
        let ProcessOwner::Uid(uid) = identity.owner else {
            return Err(SupervisorError::InvalidInput(
                "Cannot record owned process identity".to_owned(),
            ));
        };
        self.write(
            &ProcessEntry {
                pid,
                start: identity.start,
                owner: OwnerValue::Uid(uid),
                group: identity.group,
                owner_pid,
                owner_start: owner.start,
                name: name.to_owned(),
                cwd: cwd.map(str::to_owned),
                created_at: now_ms,
                tree: None,
            },
            crate::entries::EntryPlatform::current(),
        )
    }

    /// Forgets an exited process. Never throws: a delete that fails is kept
    /// and retried; a row left by a crash is harmless.
    pub fn remove(&mut self, pid: u32) {
        let now_ms = self.runtime.now_ms();
        self.unremoved.insert(pid);
        self.retry_removals(now_ms);
    }

    /// Retries the deletes that failed earlier, and takes the second empty
    /// scan for rows recovery only marked. While any is left, the caller
    /// schedules another attempt on a bounded backoff. One snapshot answers
    /// every marked row in the pass, never one walk per row.
    pub fn retry_removals(&mut self, now_ms: u64) -> RetryPlan {
        if self.closed {
            return RetryPlan::Done;
        }
        #[cfg(not(windows))]
        if !self.empty_since.is_empty() {
            let snapshot = self.runtime.group_snapshot();
            let mut wait_until: Option<u64> = None;
            let pending: Vec<(u32, u32, u64)> = self
                .empty_since
                .iter()
                .map(|(pid, (group, first))| (*pid, *group, *first))
                .collect();
            for (pid, group, first) in pending {
                match crate::system::group_empty_state(&snapshot, group) {
                    // Incomplete: proves nothing either way; keep the mark.
                    None => {
                        let at = first
                            .saturating_add(1_000)
                            .max(now_ms.saturating_add(1_000));
                        wait_until = Some(wait_until.map_or(at, |due| due.min(at)));
                    }
                    // A non-empty scan in between clears the mark; the row stays.
                    Some(false) => {
                        self.empty_since.remove(&pid);
                    }
                    Some(true) if now_ms.saturating_sub(first) < 1_000 => {
                        let at = first.saturating_add(1_000);
                        wait_until = Some(wait_until.map_or(at, |due| due.min(at)));
                    }
                    Some(true) => {
                        let db = Arc::clone(&self.db);
                        match try_delete_row(&db, pid) {
                            Ok(()) => {
                                self.empty_since.remove(&pid);
                                self.unremoved.remove(&pid);
                            }
                            Err(message) => {
                                self.unremoved.insert(pid);
                                self.failed(now_ms, message);
                                return self.plan_with_wait(now_ms, wait_until);
                            }
                        }
                    }
                }
            }
            if !self.empty_since.is_empty() {
                if let Some(due) = wait_until {
                    self.retry_at_ms = Some(match self.retry_at_ms {
                        Some(at) => at.min(due),
                        None => due,
                    });
                }
                if self.retry_at_ms.is_none() {
                    // Marks remain but nothing scheduled (all deletes just
                    // failed above already scheduled via backoff, or the only
                    // marks left were cleared this pass leaving none).
                    if self.unremoved.is_empty() {
                        return self.plan(now_ms);
                    }
                } else if self.unremoved.is_empty() {
                    return self.plan(now_ms);
                }
            }
        }
        for pid in self.unremoved.clone() {
            let db = Arc::clone(&self.db);
            match try_delete_row(&db, pid) {
                Ok(()) => {
                    self.empty_since.remove(&pid);
                    self.unremoved.remove(&pid);
                }
                Err(message) => {
                    self.failed(now_ms, message);
                    return self.plan(now_ms);
                }
            }
        }
        if !self.empty_since.is_empty() {
            return self.plan(now_ms);
        }
        self.tick.settled();
        self.retry_at_ms = None;
        RetryPlan::Done
    }

    #[cfg(not(windows))]
    fn plan_with_wait(&self, now_ms: u64, wait_until: Option<u64>) -> RetryPlan {
        match (self.retry_at_ms, wait_until) {
            (Some(at), Some(due)) => RetryPlan::RetryIn(at.min(due).saturating_sub(now_ms)),
            (Some(at), None) => RetryPlan::RetryIn(at.saturating_sub(now_ms)),
            (None, Some(due)) => RetryPlan::RetryIn(due.saturating_sub(now_ms)),
            (None, None) => self.plan(now_ms),
        }
    }

    fn failed(&mut self, now_ms: u64, message: String) {
        (self.report)(message);
        self.tick.failed(now_ms);
        let delay = inventory_backoff_ms(self.tick.failures());
        self.retry_at_ms = Some(now_ms.saturating_add(delay));
    }

    fn plan(&self, now_ms: u64) -> RetryPlan {
        match self.retry_at_ms {
            Some(at) => RetryPlan::RetryIn(at.saturating_sub(now_ms)),
            None => RetryPlan::Done,
        }
    }

    /// When the next retry is due, if one is scheduled.
    pub fn retry_at_ms(&self) -> Option<u64> {
        self.retry_at_ms
    }

    /// Closes the inventory; a pending retry never runs against it.
    pub fn close(&mut self) {
        self.closed = true;
        self.retry_at_ms = None;
        let _ = self.db.close();
    }
}

#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
impl ProbeRefused {
    fn into_error(refused: ProbeRefused, pid: u32) -> SupervisorError {
        match refused {
            ProbeRefused::Refused => {
                SupervisorError::Unavailable(format!("signal probe of {pid} refused"))
            }
            ProbeRefused::Failed(message) => SupervisorError::Operation(message),
        }
    }
}

fn query_one(
    db: &Arc<Connection>,
    sql: &str,
    params: &[Option<Value>],
) -> Result<i64, SupervisorError> {
    let statement = db
        .prepare(sql)
        .map_err(|error| SupervisorError::journal("inventory query", error))?;
    statement
        .bind(params)
        .map_err(|error| SupervisorError::journal("inventory query", error))?;
    let row = statement
        .step()
        .map_err(|error| SupervisorError::journal("inventory query", error))?;
    let Some(row) = row else {
        return Err(SupervisorError::Journal("inventory query".to_owned()));
    };
    let Value::Integer(count) = row[0] else {
        return Err(SupervisorError::Journal("inventory query".to_owned()));
    };
    Ok(count)
}

fn drain(statement: &ace_store::Statement, action: &str) -> Result<(), SupervisorError> {
    while statement
        .step()
        .map_err(|error| SupervisorError::journal(action, error))?
        .is_some()
    {}
    Ok(())
}

#[cfg(not(windows))]
fn try_delete_row(db: &Arc<Connection>, pid: u32) -> Result<(), String> {
    let statement = db
        .prepare("DELETE FROM processes WHERE pid=?")
        .map_err(|error| error.to_string())?;
    statement
        .bind(&[Some(Value::Integer(pid as i64))])
        .map_err(|_| format!("inventory delete of {pid} failed"))?;
    loop {
        match statement.step() {
            Ok(None) => break,
            Ok(Some(_)) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
