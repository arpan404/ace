// SPDX-License-Identifier: Apache-2.0
//! Windows inventory: trees recorded by proven ancestry, and the recorder
//! tick that adds descendants while their parents still prove them.

use super::{Inventory, InventoryRuntime};
use crate::entries::{INVENTORY_CAPACITY, OwnerValue, ProcessEntry};
use crate::errors::SupervisorError;
use crate::identity::ProcessOwner;

impl<R: InventoryRuntime> Inventory<R> {
    /// Windows only: records one owned leader and arms the descendant
    /// recorder. A tick runs on an interval; a failed write is reported
    /// and retried on a backoff, never thrown.
    pub fn windows_add(
        &mut self,
        pid: u32,
        name: &str,
        cwd: Option<&str>,
    ) -> Result<(), SupervisorError> {
        use crate::entries::EntryPlatform;
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
    fn record_windows_trees(
        &mut self,
        tree: &dyn crate::wintree::WindowsTreeOps,
    ) -> Result<bool, SupervisorError> {
        use crate::entries::EntryPlatform;
        use crate::wintree::WindowsRecord;
        let mut owned = false;
        for (key, entries) in self.windows_trees()? {
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
            let state = tree.state(&recorded)?;
            let room = (INVENTORY_CAPACITY - self.count()?).max(0) as usize;
            for member in state.discovered.iter().take(room) {
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
                        tree: Some(key.clone()),
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
    pub(crate) fn windows_trees(
        &self,
    ) -> Result<Vec<(String, Vec<ProcessEntry>)>, SupervisorError> {
        // In first-seen order, like the TypeScript `Map`: capacity is spent
        // on the trees listed first.
        let mut trees: Vec<(String, Vec<ProcessEntry>)> = Vec::new();
        for entry in self.list()? {
            let key = entry
                .tree
                .clone()
                .unwrap_or_else(|| format!("{}:{}", entry.pid, entry.start));
            match trees.iter_mut().find(|(known, _)| *known == key) {
                Some((_, members)) => members.push(entry),
                None => trees.push((key, vec![entry])),
            }
        }
        Ok(trees)
    }
}
