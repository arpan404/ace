// SPDX-License-Identifier: Apache-2.0
//! Startup recovery: what the previous run left recorded, ended or kept.
//! Ports the recovery half of `process-inventory.ts`. A group kill never
//! reaches an escapee; only proven members are ended, and whatever cannot
//! be proven stays recorded for a later start.

use crate::entries::{OwnerValue, parse_entry};
use crate::errors::SupervisorError;
use crate::identity::ProcessOwner;
use crate::inventory::{Inventory, InventoryRuntime, ProbeRefused};
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
        {
            let partial = self.windows_recover()?;
            return Ok(Recovered {
                removed: partial.removed,
                killed: partial.killed,
                unresolved: 0,
            });
        }
        #[cfg(not(windows))]
        {
            self.posix_recover()
        }
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
            let current = self
                .runtime
                .identity(entry.pid)
                .unwrap_or_default();
            match self.group_alive(entry.group) {
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
            // The group lives on, but its leader is gone or its pid is
            // someone else's now: neither ended nor called stopped.
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
            self.runtime.kill(entry.group);
            // Kept as evidence until a later recovery proves the group gone.
            recovered.killed += 1;
        }
        Ok(recovered)
    }

    /// Liveness of a recorded group, or `Refused` when the kernel refuses.
    fn group_alive(&self, group: u32) -> Result<bool, ProbeRefused> {
        self.runtime.alive(group)
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::Inventory;
    use crate::test_scratch::{Fake, Scratch, identity};
    use std::sync::Arc;

    fn open(path: &str, runtime: Fake) -> Inventory<Fake> {
        Inventory::open(path, runtime, Arc::new(|_| {})).expect("inventory opens")
    }

    #[test]
    fn orphan_recovery_kills_no_identity_mismatch() {
        for kind in ["pid", "start", "uid", "group", "missing", "unreadable"] {
            let scratch = Scratch::new();
            let (mut fake, _) = Fake::new(10);
            fake.insert(10, "owner-start", 1000, 10);
            fake.insert(20, "child-start", 1000, 20);
            let mut inventory = open(&scratch.file("processes.sqlite"), fake);
            inventory.add(20, "synthetic", None).expect("adds");
            inventory.runtime.processes.remove(&10);
            match kind {
                "pid" => {
                    inventory
                        .runtime
                        .processes
                        .insert(20, identity(21, "child-start"));
                }
                "start" => {
                    inventory
                        .runtime
                        .processes
                        .insert(20, identity(20, "recycled"));
                }
                "uid" => {
                    let mut current = identity(20, "child-start");
                    current.owner = crate::identity::ProcessOwner::Uid(1001);
                    inventory.runtime.processes.insert(20, current);
                }
                "group" => {
                    let mut current = identity(20, "child-start");
                    current.group = 21;
                    inventory.runtime.processes.insert(20, current);
                }
                "missing" => {
                    inventory.runtime.processes.remove(&20);
                }
                _ => {
                    inventory.runtime.unreadable.push(20);
                }
            }
            // Not the run's provably: left running and on record, and
            // startup goes on unverified.
            assert_eq!(
                inventory.recover().expect("recovers"),
                Recovered {
                    removed: 0,
                    killed: 0,
                    unresolved: 1,
                },
                "{kind}"
            );
            assert_eq!(inventory.list().expect("lists").len(), 1, "{kind}");
            inventory.close();
        }
    }

    #[test]
    fn recovery_keeps_a_live_owner_and_kills_only_a_verified_orphan() {
        let scratch = Scratch::new();
        let (mut fake, killed) = Fake::new(10);
        fake.insert(10, "owner-start", 1000, 10);
        fake.insert(20, "child-start", 1000, 20);
        let mut inventory = open(&scratch.file("processes.sqlite"), fake);
        inventory.add(20, "synthetic", None).expect("adds");
        assert_eq!(
            inventory.recover().expect("recovers"),
            Recovered {
                removed: 0,
                killed: 0,
                unresolved: 0,
            }
        );
        assert!(killed.borrow().is_empty());
        inventory.runtime.processes.remove(&10);
        assert_eq!(
            inventory.recover().expect("recovers"),
            Recovered {
                removed: 0,
                killed: 1,
                unresolved: 0,
            }
        );
        assert_eq!(killed.borrow().clone(), vec![20]);
        inventory.close();
    }

    #[test]
    fn refused_group_probe_is_kept_for_later() {
        let scratch = Scratch::new();
        let (mut fake, killed) = Fake::new(10);
        fake.insert(10, "owner-start", 1000, 10);
        fake.insert(20, "exiting", 1000, 20);
        fake.insert(30, "orphan", 1000, 30);
        fake.alive.insert(20, Err(ProbeRefused::Refused));
        let mut inventory = open(&scratch.file("processes.sqlite"), fake);
        inventory.add(20, "synthetic", None).expect("adds");
        inventory.add(30, "synthetic", None).expect("adds");
        inventory.runtime.processes.remove(&10);
        assert_eq!(
            inventory.recover().expect("recovers"),
            Recovered {
                removed: 0,
                killed: 1,
                unresolved: 1,
            }
        );
        assert_eq!(killed.borrow().clone(), vec![30]);
        assert!(
            inventory
                .list()
                .expect("lists")
                .iter()
                .any(|entry| entry.pid == 20)
        );
        inventory.runtime.alive.insert(20, Ok(false));
        let recovered = inventory.recover().expect("recovers");
        assert_eq!(recovered.unresolved, 0);
        assert_eq!(recovered.removed, 1);
        assert!(
            !inventory
                .list()
                .expect("lists")
                .iter()
                .any(|entry| entry.pid == 20)
        );
        inventory.close();
    }

    #[test]
    fn probe_failure_other_than_refused_stops_recovery() {
        let scratch = Scratch::new();
        let (mut fake, _) = Fake::new(10);
        fake.insert(10, "owner-start", 1000, 10);
        fake.insert(20, "child", 1000, 20);
        fake.alive
            .insert(20, Err(ProbeRefused::Failed("kill EINVAL".to_owned())));
        let mut inventory = open(&scratch.file("processes.sqlite"), fake);
        inventory.add(20, "synthetic", None).expect("adds");
        inventory.runtime.processes.remove(&10);
        assert!(inventory.recover().is_err());
        inventory.close();
    }
}
