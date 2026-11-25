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
#[cfg(not(windows))]
use crate::retry::inventory_retry_ms;
use crate::retry::{GuardedTick, inventory_backoff_ms};
use ace_store::{Connection, OpenOptions, Value};
use std::collections::HashSet;
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

/// Recheck delay while a release is still confirming its group empty: the
/// check wakes its release loop to scan now, so confirmation is near;
/// until then the row stays for crash recovery to find. Every platform
/// uses it as the retry-delay floor.
const GATE_RECHECK_MS: u64 = 250;

/// The process inventory over `path`, opened through the store's connection
/// so one SQLite library touches the file.
pub struct Inventory<R> {
    pub(crate) db: Arc<Connection>,
    pub(crate) runtime: R,
    report: Arc<dyn Fn(String) + Send + Sync>,
    pub(crate) unremoved: HashSet<u32>,
    tick: GuardedTick,
    retry_at_ms: Option<u64>,
    /// Passes in a row that left a row unconfirmed: its recheck backs off.
    unconfirmed_passes: u32,
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
            tick: GuardedTick::new(),
            retry_at_ms: None,
            unconfirmed_passes: 0,
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
    /// and retried; a row left by a crash is harmless. The row stays until
    /// its group is confirmed empty (the release loop's own report, or two
    /// snapshots); a later retry re-checks.
    pub fn remove(&mut self, pid: u32) {
        let now_ms = self.runtime.now_ms();
        #[cfg(not(windows))]
        match self.recorded(pid) {
            // A row that cannot be read is not an absent row: keep it and
            // look again, never delete what the check never saw.
            Err(_) => {
                self.unremoved.insert(pid);
                self.schedule_recheck(now_ms);
                return;
            }
            Ok(Some(entry)) => {
                let mut snapshots = None;
                if !self.release_empty(&mut snapshots, &entry) {
                    self.unremoved.insert(pid);
                    self.schedule_recheck(now_ms);
                    return;
                }
            }
            Ok(None) => {}
        }
        self.unremoved.insert(pid);
        self.retry_removals(now_ms);
    }

    /// Schedules the next row check, keeping an unexpired earlier one. An
    /// expired deadline is replaced, never reused: it would fire at once.
    #[cfg(not(windows))]
    fn schedule_recheck(&mut self, now_ms: u64) {
        let at = now_ms.saturating_add(GATE_RECHECK_MS);
        self.retry_at_ms = Some(match self.retry_at_ms {
            Some(earlier) if earlier > now_ms => earlier.min(at),
            _ => at,
        });
    }

    /// The recorded row for `pid`. `Ok(None)` means there is no row;
    /// `Err` means the lookup itself failed, which proves nothing and must
    /// keep the row for a later retry.
    #[cfg(not(windows))]
    fn recorded(&self, pid: u32) -> Result<Option<ProcessEntry>, SupervisorError> {
        let action = "inventory read";
        let statement = self
            .db
            .prepare("SELECT entry FROM processes WHERE pid=?")
            .map_err(|error| SupervisorError::journal(action, error))?;
        statement
            .bind(&[Some(Value::Integer(pid as i64))])
            .map_err(|error| SupervisorError::journal(action, error))?;
        let Some(row) = statement
            .step()
            .map_err(|error| SupervisorError::journal(action, error))?
        else {
            return Ok(None);
        };
        let Value::Text(text) = &row[0] else {
            return Err(SupervisorError::Journal(
                "inventory row is not text".to_owned(),
            ));
        };
        parse_entry(text).map(Some)
    }

    /// Whether the row for a recorded group may be forgotten: its group is
    /// confirmed empty. A leader this supervisor holds reports its own
    /// release (two empty scans while held); otherwise two back-to-back
    /// snapshots must both find the group empty and complete. `false`
    /// proves nothing either way: the row stays for a later retry. One
    /// snapshot pair answers every such row in the pass.
    #[cfg(not(windows))]
    fn release_empty(
        &self,
        snapshots: &mut Option<(
            crate::system::GroupSnapshot,
            Option<crate::system::GroupSnapshot>,
        )>,
        entry: &ProcessEntry,
    ) -> bool {
        // The check wakes the release loop to scan now when unconfirmed.
        if let Some(leader) = crate::leader::group_leader(entry.pid, &entry.start) {
            // The latch counts only if the pin was held in the same read:
            // a release that reaped in between leaves the group number
            // free for reuse, so a fresh snapshot must decide.
            let (pinned, gone) = leader.pin_and_gone();
            if pinned {
                return gone;
            }
        }
        if snapshots.is_none() {
            *snapshots = Some((self.runtime.group_snapshot(), None));
        }
        let first_empty = snapshots.as_ref().is_some_and(|(first, _)| {
            crate::system::group_empty_state(first, entry.group) == Some(true)
        });
        if !first_empty {
            return false;
        }
        if snapshots
            .as_ref()
            .is_some_and(|(_, second)| second.is_none())
        {
            let second = self.runtime.group_snapshot();
            if let Some((_, slot)) = snapshots.as_mut() {
                *slot = Some(second);
            }
        }
        snapshots.as_ref().is_some_and(|(_, second)| {
            second.as_ref().is_some_and(|snapshot| {
                crate::system::group_empty_state(snapshot, entry.group) == Some(true)
            })
        })
    }

    /// Retries the deletes that failed earlier. While any is left, the
    /// caller schedules another attempt on a bounded backoff. A pending
    /// delete is retried only once its group is still empty: a group that
    /// gained (or may hold) members keeps its row for a later retry.
    pub fn retry_removals(&mut self, now_ms: u64) -> RetryPlan {
        if self.closed {
            return RetryPlan::Done;
        }
        // One snapshot pair answers every row that needs one in the pass.
        #[cfg(not(windows))]
        let mut snapshots: Option<(
            crate::system::GroupSnapshot,
            Option<crate::system::GroupSnapshot>,
        )> = None;
        #[cfg(not(windows))]
        let mut waiting = false;
        for pid in self.unremoved.clone() {
            #[cfg(not(windows))]
            match self.recorded(pid) {
                // A lookup that failed proves nothing: keep the row.
                Err(_) => {
                    waiting = true;
                    continue;
                }
                Ok(None) => {}
                Ok(Some(entry)) => {
                    if !self.release_empty(&mut snapshots, &entry) {
                        // Still occupied, or nothing proves it gone: keep
                        // the row and look again after a backoff.
                        waiting = true;
                        continue;
                    }
                }
            }
            if !self.delete_row(pid, now_ms) {
                return self.plan(now_ms);
            }
        }
        #[cfg(not(windows))]
        if waiting {
            // A row that stays unconfirmed backs off instead of retrying
            // at the recheck floor for ever.
            self.unconfirmed_passes = self.unconfirmed_passes.saturating_add(1);
            let due = now_ms.saturating_add(inventory_retry_ms(
                self.unconfirmed_passes,
                GATE_RECHECK_MS,
                30_000,
            ));
            // Never reuse an expired deadline: it would fire at once.
            self.retry_at_ms = Some(match self.retry_at_ms {
                Some(at) if at > now_ms => at.min(due),
                _ => due,
            });
            return self.plan(now_ms);
        }
        self.unconfirmed_passes = 0;
        self.tick.settled();
        self.retry_at_ms = None;
        RetryPlan::Done
    }

    /// Deletes one recorded row outright. A failed delete is reported and
    /// kept for the retry pass; true once the row is gone.
    pub(crate) fn delete_row(&mut self, pid: u32, now_ms: u64) -> bool {
        let statement = match self.db.prepare("DELETE FROM processes WHERE pid=?") {
            Ok(statement) => statement,
            Err(error) => {
                self.failed(now_ms, error.to_string());
                return false;
            }
        };
        if statement.bind(&[Some(Value::Integer(pid as i64))]).is_err() {
            self.failed(now_ms, format!("inventory delete of {pid} failed"));
            return false;
        }
        let mut failed: Option<String> = None;
        loop {
            match statement.step() {
                Ok(None) => break,
                Ok(Some(_)) => {}
                Err(error) => {
                    failed = Some(error.to_string());
                    break;
                }
            }
        }
        if let Some(message) = failed {
            self.failed(now_ms, message);
            return false;
        }
        self.unremoved.remove(&pid);
        true
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

    /// The delay until the next retry at `now_ms`, if one is scheduled:
    /// never below the recheck floor (an expired deadline must not spin)
    /// and never above this inventory's current backoff.
    pub fn retry_delay_ms(&self, now_ms: u64) -> Option<u64> {
        let at = self.retry_at_ms?;
        let failures = self.tick.failures().max(self.unconfirmed_passes).max(1);
        Some(
            at.saturating_sub(now_ms)
                .clamp(GATE_RECHECK_MS, inventory_backoff_ms(failures)),
        )
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

#[cfg(test)]
mod tests;
