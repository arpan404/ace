// SPDX-License-Identifier: Apache-2.0
//! Owned groups recorded by pid, kernel start and owner in a small SQLite
//! journal, so the next start or `ace stop` can stop exactly them. Ports
//! `process-inventory.ts`: rows, deletes retried on a bounded backoff, and
//! the capacity bound. Recovery lives in `recover.rs`.

use crate::entries::{INVENTORY_CAPACITY, OwnerValue, ProcessEntry, entry_json, parse_entry};
use crate::errors::SupervisorError;
use crate::identity::{ProcessIdentity, ProcessOwner};
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
    /// Whether a group answers a probe: gone, refused, or failed.
    fn alive(&self, group: u32) -> Result<bool, ProbeRefused>;
    /// Ends a group; races with its exit stay silent.
    fn kill(&self, group: u32);
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
    tick: GuardedTick,
    retry_at_ms: Option<u64>,
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
            closed: false,
            #[cfg(windows)]
            windows_due_ms: None,
        })
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
        {
            return self.windows_add(pid, name, cwd);
        }
        #[cfg(not(windows))]
        {
            self.posix_add(pid, name, cwd)
        }
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

    /// Retries the deletes that failed earlier. While any is left, the
    /// caller schedules another attempt on a bounded backoff.
    pub fn retry_removals(&mut self, now_ms: u64) -> RetryPlan {
        if self.closed {
            return RetryPlan::Done;
        }
        for pid in self.unremoved.clone() {
            let statement = match self.db.prepare("DELETE FROM processes WHERE pid=?") {
                Ok(statement) => statement,
                Err(error) => {
                    self.failed(now_ms, error.to_string());
                    return self.plan(now_ms);
                }
            };
            if statement.bind(&[Some(Value::Integer(pid as i64))]).is_err() {
                self.failed(now_ms, format!("inventory delete of {pid} failed"));
                return self.plan(now_ms);
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
                return self.plan(now_ms);
            }
            self.unremoved.remove(&pid);
        }
        self.tick.settled();
        self.retry_at_ms = None;
        RetryPlan::Done
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

    /// Windows only: records one owned leader and arms the descendant
    /// recorder. A tick runs on an interval; a failed write is reported
    /// and retried on a backoff, never thrown.
    #[cfg(windows)]
    pub fn windows_add(
        &mut self,
        pid: u32,
        name: &str,
        cwd: Option<&str>,
    ) -> Result<(), SupervisorError> {
        use crate::entries::EntryPlatform;
        use crate::identity::ProcessOwner;
        let now_ms = self.runtime.now_ms();
        let identity = self.runtime.identity(pid)?.ok_or_else(|| {
            SupervisorError::InvalidInput("Cannot record owned process identity".to_owned())
        })?;
        let owner_pid = self.runtime.owner_pid();
        let owner = self.runtime.identity(owner_pid)?.ok_or_else(|| {
            SupervisorError::InvalidInput("Cannot record owned process identity".to_owned())
        })?;
        if identity.pid != pid || owner.pid != owner_pid || identity.owner != owner.owner {
            return Err(SupervisorError::InvalidInput(
                "Cannot record owned process identity".to_owned(),
            ));
        }
        if self.count()? >= INVENTORY_CAPACITY {
            return Err(SupervisorError::Limit(
                "Process inventory capacity".to_owned(),
            ));
        }
        self.write(
            &ProcessEntry {
                pid,
                start: identity.start,
                owner: match identity.owner {
                    ProcessOwner::Uid(uid) => OwnerValue::Uid(uid),
                    ProcessOwner::Sid(sid) => OwnerValue::Sid(sid),
                },
                group: pid,
                owner_pid,
                owner_start: owner.start,
                name: name.to_owned(),
                cwd: cwd.map(str::to_owned),
                created_at: now_ms,
                tree: None,
            },
            EntryPlatform::Windows,
        )?;
        self.windows_due_ms = Some(now_ms);
        Ok(())
    }

    /// Windows only: one recorder tick. Returns whether the interval stays.
    #[cfg(windows)]
    pub fn windows_tick(&mut self, now_ms: u64, tree: &dyn crate::wintree::WindowsTreeOps) -> bool {
        if self.windows_due_ms.is_none() {
            return false;
        }
        if !self.tick.ready(now_ms) {
            return true;
        }
        match self.record_windows_trees(tree) {
            Ok(owned) => {
                self.tick.settled();
                if !owned {
                    self.windows_due_ms = None;
                    return false;
                }
                self.windows_due_ms = Some(now_ms.saturating_add(1_000));
                true
            }
            Err(error) => {
                (self.report)(error.to_string());
                self.tick.failed(now_ms);
                true
            }
        }
    }

    /// Windows only: records newly proven descendants of this daemon's
    /// trees and drops members proven gone. Returns whether any of this
    /// daemon's trees remain recorded.
    #[cfg(windows)]
    fn record_windows_trees(
        &mut self,
        tree: &dyn crate::wintree::WindowsTreeOps,
    ) -> Result<bool, SupervisorError> {
        use crate::entries::EntryPlatform;
        use crate::wintree::WindowsRecord;
        let mut owned = false;
        for (_, entries) in self.windows_trees()? {
            let Some(leader) = entries
                .iter()
                .find(|entry| entry.tree.is_none())
                .or(entries.first())
            else {
                continue;
            };
            if leader.owner_pid != self.runtime.owner_pid() {
                continue;
            }
            owned = true;
            let recorded: Vec<WindowsRecord> = entries
                .iter()
                .map(|entry| WindowsRecord {
                    pid: entry.pid,
                    start: entry.start.clone(),
                    uid: match &entry.owner {
                        OwnerValue::Uid(uid) => uid.to_string(),
                        OwnerValue::Sid(sid) => sid.clone(),
                    },
                })
                .collect();
            let state = tree.state(&recorded);
            let room = (INVENTORY_CAPACITY - self.count()?).max(0) as usize;
            for member in state.discovered.iter().take(room) {
                let key = format!("{}:{}", leader.pid, leader.start);
                self.write(
                    &ProcessEntry {
                        pid: member.pid,
                        start: member.start.clone(),
                        owner: match &leader.owner {
                            OwnerValue::Uid(uid) => OwnerValue::Uid(*uid),
                            OwnerValue::Sid(sid) => OwnerValue::Sid(sid.clone()),
                        },
                        group: member.pid,
                        owner_pid: leader.owner_pid,
                        owner_start: leader.owner_start.clone(),
                        name: leader.name.clone(),
                        cwd: leader.cwd.clone(),
                        created_at: self.runtime.now_ms(),
                        tree: Some(key),
                    },
                    EntryPlatform::Windows,
                )?;
                self.unremoved.remove(&member.pid);
            }
            // A gone member stays as evidence while a live process still
            // names it as parent.
            if state.ambiguous.is_empty() {
                for gone in &state.gone {
                    if entries
                        .iter()
                        .any(|entry| entry.pid == gone.pid && entry.tree.is_some())
                    {
                        let now_ms = self.runtime.now_ms();
                        self.unremoved.insert(gone.pid);
                        self.retry_removals(now_ms);
                    }
                }
            }
        }
        Ok(owned)
    }

    /// Windows only: the recorded trees grouped by leader.
    #[cfg(windows)]
    pub(crate) fn windows_trees(
        &self,
    ) -> Result<Vec<(String, Vec<ProcessEntry>)>, SupervisorError> {
        let mut trees: std::collections::HashMap<String, Vec<ProcessEntry>> =
            std::collections::HashMap::new();
        for entry in self.list()? {
            let key = entry
                .tree
                .clone()
                .unwrap_or_else(|| format!("{}:{}", entry.pid, entry.start));
            trees.entry(key).or_default().push(entry);
        }
        Ok(trees.into_iter().collect())
    }
}

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
mod tests {
    use super::*;
    use crate::test_scratch::{Fake, Scratch, identity};
    use std::sync::Arc;

    fn open(path: &str, runtime: Fake) -> Inventory<Fake> {
        Inventory::open(path, runtime, Arc::new(|_| {})).expect("inventory opens")
    }

    #[test]
    fn unremoved_rows_retry_and_a_reused_pid_survives() {
        let scratch = Scratch::new();
        let path = scratch.file("processes.sqlite");
        let (mut fake, _) = Fake::new(10);
        fake.insert(10, "owner-start", 1000, 10);
        fake.insert(20, "first", 1000, 20);
        fake.insert(30, "other", 1000, 30);
        let mut inventory = open(&path, fake);
        inventory.add(20, "first", None).expect("adds");
        inventory.add(30, "other", None).expect("adds");
        // Another writer holds the file, so the deletes fail like a full disk.
        let blocker = Connection::open(&path, OpenOptions::default()).expect("blocker opens");
        blocker.exec("BEGIN IMMEDIATE").expect("blocks");
        inventory.remove(20);
        inventory.remove(30);
        assert!(inventory.retry_at_ms().is_some());
        blocker.exec("ROLLBACK").expect("unblocks");
        // The pid is reused before the retry: the new row must survive it.
        inventory
            .runtime
            .processes
            .insert(20, identity(20, "second"));
        inventory.add(20, "second", None).expect("adds");
        assert_eq!(inventory.retry_removals(1), RetryPlan::Done);
        assert_eq!(
            inventory
                .list()
                .expect("lists")
                .into_iter()
                .map(|entry| (entry.pid, entry.start))
                .collect::<Vec<_>>(),
            vec![(20, "second".to_owned())]
        );
        inventory.close();
        blocker.close().expect("blocker closes");
    }

    #[test]
    fn failing_deletes_retry_on_backoff_and_close_cancels() {
        let scratch = Scratch::new();
        let path = scratch.file("processes.sqlite");
        let (mut fake, _) = Fake::new(10);
        fake.insert(10, "owner-start", 1000, 10);
        fake.insert(20, "child", 1000, 20);
        let mut inventory = open(&path, fake);
        inventory.add(20, "child", None).expect("adds");
        let blocker = Connection::open(&path, OpenOptions::default()).expect("blocker opens");
        blocker.exec("BEGIN IMMEDIATE").expect("blocks");
        inventory.remove(20);
        assert_eq!(inventory.retry_at_ms(), Some(1_000));
        // The scheduled retry finds the file still locked: another, later one.
        blocker.exec("ROLLBACK").expect("unblocks");
        blocker.exec("BEGIN IMMEDIATE").expect("blocks");
        assert_eq!(inventory.retry_removals(1_000), RetryPlan::RetryIn(2_000));
        blocker.exec("ROLLBACK").expect("unblocks");
        assert_eq!(inventory.retry_removals(3_000), RetryPlan::Done);
        assert!(inventory.list().expect("lists").is_empty());
        assert_eq!(inventory.retry_at_ms(), None);
        inventory.close();
        blocker.close().expect("blocker closes");
    }
}
