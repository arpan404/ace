// SPDX-License-Identifier: Apache-2.0
//! Startup recovery: what the previous run left recorded, ended or kept.
//! Ports the recovery half of `process-inventory.ts`. A group kill never
//! reaches an escapee; only proven members are ended, and whatever cannot
//! be proven stays recorded for a later start.

use crate::entries::{OwnerValue, parse_entry};
use crate::errors::SupervisorError;
use crate::identity::ProcessOwner;
#[cfg(not(windows))]
use crate::inventory::ProbeRefused;
use crate::inventory::{Inventory, InventoryRuntime};
use ace_store::{Connection, OpenOptions, Value};
use std::sync::Arc;

/// What one recovery did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Recovered {
    /// Recorded groups proven gone and forgotten.
    pub removed: u32,
    /// Verified orphans ended; kept as evidence until proven gone.
    pub killed: u32,
    /// Members that cannot be proven either way, kept for a later start.
    pub unresolved: u32,
}

impl<R: InventoryRuntime> Inventory<R> {
    /// Recovers what the previous run left recorded: ends verified
    /// orphans, forgets groups proven gone, keeps the rest as evidence.
    pub fn recover(&mut self) -> Result<Recovered, SupervisorError> {
        #[cfg(windows)]
        let recovered = self
            .windows_recover(&crate::wintree::SystemWindowsTree::new())
            .map(|partial| Recovered {
                removed: partial.removed,
                killed: partial.killed,
                unresolved: 0,
            });
        #[cfg(not(windows))]
        let recovered = self.posix_recover();
        recovered
    }

    /// Windows only: recovery that also counts trees left recorded because
    /// some member cannot be proven.
    #[cfg(windows)]
    fn windows_recover(
        &mut self,
        tree: &dyn crate::wintree::WindowsTreeOps,
    ) -> Result<Recovered, SupervisorError> {
        use crate::entries::{EntryPlatform, OwnerValue, ProcessEntry};
        use crate::wintree::WindowsRecord;
        let now_ms = self.runtime.now_ms();
        let mut recovered = Recovered::default();
        for (key, entries) in self.windows_trees()? {
            let Some(leader) = entries
                .iter()
                .find(|entry| entry.tree.is_none())
                .or(entries.first())
            else {
                continue;
            };
            if entries.iter().any(|entry| {
                self.runtime
                    .identity(entry.owner_pid)
                    .ok()
                    .flatten()
                    .is_some_and(|owner| {
                        owner.pid == entry.owner_pid
                            && owner.start == entry.owner_start
                            && owner.owner == ProcessOwner::of(&entry.owner)
                    })
            }) {
                continue;
            }
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
            let state = tree.state(&recorded)?;
            for member in &state.discovered {
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
                        created_at: now_ms,
                        tree: Some(key.clone()),
                    },
                    EntryPlatform::Windows,
                )?;
                self.unremoved.remove(&member.pid);
            }
            if state.live.is_empty() && state.ambiguous.is_empty() {
                for entry in &entries {
                    self.unremoved.insert(entry.pid);
                }
                self.retry_removals(now_ms);
                recovered.removed += 1;
                continue;
            }
            for member in &state.live {
                tree.terminate(&crate::wintree::WindowsRecord {
                    pid: member.pid,
                    start: member.start.clone(),
                    uid: member.uid.clone(),
                })?;
            }
            // Evidence stays until a later recovery proves every member gone.
            if !state.live.is_empty() {
                recovered.killed += 1;
            }
            if !state.ambiguous.is_empty() {
                recovered.unresolved += 1;
            }
        }
        Ok(recovered)
    }

    #[cfg(not(windows))]
    fn posix_recover(&mut self) -> Result<Recovered, SupervisorError> {
        let now_ms = self.runtime.now_ms();
        let mut recovered = Recovered::default();
        for entry in self.list()? {
            let owner = self.runtime.identity(entry.owner_pid)?;
            if owner.as_ref().is_some_and(|owned| {
                owned.pid == entry.owner_pid
                    && owned.start == entry.owner_start
                    && owned.owner == ProcessOwner::of(&entry.owner)
            }) {
                continue;
            }
            let current = self.runtime.identity(entry.pid).unwrap_or_default();
            match self.runtime.leader_alive(entry.pid, &entry.start) {
                Err(ProbeRefused::Refused) => {
                    recovered.unresolved += 1;
                    continue;
                }
                Err(ProbeRefused::Failed(message)) => {
                    return Err(SupervisorError::Operation(message));
                }
                Ok(false) => {
                    self.remove_inner(entry.pid, now_ms);
                    recovered.removed += 1;
                    continue;
                }
                Ok(true) => {}
            }
            // The leader runs as itself, but its owner or group changed:
            // neither ended nor called stopped. A leader that is gone was
            // forgotten above: without it nothing proves the group is the
            // run's, and its number is never signalled.
            let verified = current.as_ref().is_some_and(|identity| {
                identity.pid == entry.pid
                    && identity.start == entry.start
                    && identity.owner == ProcessOwner::of(&entry.owner)
                    && identity.group == entry.group
            });
            if !verified {
                recovered.unresolved += 1;
                continue;
            }
            self.runtime.kill(entry.group, &entry.start);
            // Kept as evidence until a later recovery proves the group gone.
            recovered.killed += 1;
        }
        Ok(recovered)
    }

    #[cfg(not(windows))]
    fn remove_inner(&mut self, pid: u32, now_ms: u64) {
        // Mirrors `remove` without re-reading the clock.
        self.unremoved.insert(pid);
        self.retry_removals(now_ms);
    }
}

impl ProcessOwner {
    fn of(owner: &OwnerValue) -> Self {
        match owner {
            OwnerValue::Uid(uid) => Self::Uid(*uid),
            OwnerValue::Sid(sid) => Self::Sid(sid.clone()),
        }
    }
}

/// Read-only, for `ace stop`: what the inventory records as owned by one
/// daemon run, by pid and start. A home whose inventory never recorded a
/// process has no table: nothing owned, not unknown.
pub fn read_owned_groups(
    path: &str,
    owner_pid: u32,
    owner_start: &str,
) -> Result<Vec<(u32, String)>, SupervisorError> {
    if !std::path::Path::new(path).exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open(
        path,
        OpenOptions {
            read_only: true,
            ..OpenOptions::default()
        },
    )
    .map_err(|error| SupervisorError::journal("inventory open", error))?;
    let has = has_table(&db, "processes")?;
    let mut owned = Vec::new();
    if has {
        let statement = db
            .prepare("SELECT entry FROM processes ORDER BY pid")
            .map_err(|error| SupervisorError::journal("inventory read", error))?;
        statement
            .bind(&[])
            .map_err(|error| SupervisorError::journal("inventory read", error))?;
        while let Some(row) = statement
            .step()
            .map_err(|error| SupervisorError::journal("inventory read", error))?
        {
            let Value::Text(text) = &row[0] else {
                continue;
            };
            let Ok(entry) = parse_entry(text) else {
                continue;
            };
            if entry.owner_pid == owner_pid && entry.owner_start == owner_start {
                owned.push((entry.pid, entry.start));
            }
        }
    }
    db.close()
        .map_err(|error| SupervisorError::journal("inventory close", error))?;
    Ok(owned)
}

fn has_table(db: &Arc<Connection>, table: &str) -> Result<bool, SupervisorError> {
    let statement = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .map_err(|error| SupervisorError::journal("inventory tables", error))?;
    statement
        .bind(&[Some(Value::Text(table.to_owned()))])
        .map_err(|error| SupervisorError::journal("inventory tables", error))?;
    Ok(statement
        .step()
        .map_err(|error| SupervisorError::journal("inventory tables", error))?
        .is_some())
}

/// Windows only: whether a journal still records the tree a leader started.
/// A recovery that could not prove every member gone keeps that record, so
/// its owners keep their resources.
#[cfg(windows)]
pub fn windows_tree_recorded(
    path: &str,
    leader_pid: u32,
    leader_start: &str,
) -> Result<bool, SupervisorError> {
    if !std::path::Path::new(path).exists() {
        return Ok(false);
    }
    let db = Connection::open(
        path,
        OpenOptions {
            read_only: true,
            ..OpenOptions::default()
        },
    )
    .map_err(|error| SupervisorError::journal("inventory open", error))?;
    let key = format!("{leader_pid}:{leader_start}");
    let statement = db
        .prepare("SELECT entry FROM processes")
        .map_err(|error| SupervisorError::journal("inventory read", error))?;
    statement
        .bind(&[])
        .map_err(|error| SupervisorError::journal("inventory read", error))?;
    while let Some(row) = statement
        .step()
        .map_err(|error| SupervisorError::journal("inventory read", error))?
    {
        let Value::Text(text) = &row[0] else {
            continue;
        };
        let entry = parse_entry(text)?;
        if entry.tree.as_deref() == Some(key.as_str())
            || (entry.pid == leader_pid && entry.start == leader_start)
        {
            db.close()
                .map_err(|error| SupervisorError::journal("inventory close", error))?;
            return Ok(true);
        }
    }
    db.close()
        .map_err(|error| SupervisorError::journal("inventory close", error))?;
    Ok(false)
}

// POSIX recovery: Windows recovers trees instead (`windows_recover`).
#[cfg(test)]
#[cfg(not(windows))]
mod tests;
