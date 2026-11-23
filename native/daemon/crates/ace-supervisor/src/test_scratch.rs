// SPDX-License-Identifier: Apache-2.0
//! Test-only SQLite scratch files and inventory fakes for the suites that
//! prove the inventory and its recovery. Never compiled into the addon.
#![cfg(test)]

use crate::errors::SupervisorError;
use crate::identity::{ProcessIdentity, ProcessOwner};
use crate::inventory::{InventoryRuntime, ProbeRefused};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A scratch directory, removed when the test ends. std only.
pub struct Scratch {
    path: std::path::PathBuf,
}

impl Scratch {
    /// Creates a fresh scratch directory.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ace-supervisor-inventory-{id}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("scratch dir creates");
        Self { path }
    }

    /// A database file inside the scratch directory.
    pub fn file(&self, name: &str) -> String {
        self.path.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A fake inventory runtime: scripted identities, liveness and kills.
pub struct Fake {
    /// Processes the kernel reports, by pid.
    pub processes: HashMap<u32, ProcessIdentity>,
    /// Groups the runtime was told to kill, in order.
    pub killed: Rc<RefCell<Vec<u32>>>,
    /// Scripted liveness per group; unlisted groups answer alive.
    pub alive: HashMap<u32, Result<bool, ProbeRefused>>,
    /// Pids whose identity read throws.
    pub unreadable: Vec<u32>,
    /// The daemon's own pid: the owner recorded rows name.
    pub owner: u32,
}

impl Fake {
    /// Starts empty, owned by `owner`; returns the kill log with it.
    pub fn new(owner: u32) -> (Self, Rc<RefCell<Vec<u32>>>) {
        let killed = Rc::new(RefCell::new(Vec::new()));
        (
            Self {
                processes: HashMap::new(),
                killed: Rc::clone(&killed),
                alive: HashMap::new(),
                unreadable: Vec::new(),
                owner,
            },
            killed,
        )
    }

    /// Records a running process the kernel would report.
    pub fn insert(&mut self, pid: u32, start: &str, uid: u32, group: u32) {
        self.processes.insert(
            pid,
            ProcessIdentity {
                pid,
                start: start.to_owned(),
                owner: ProcessOwner::Uid(uid),
                group,
            },
        );
    }
}

impl InventoryRuntime for Fake {
    fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
        if self.unreadable.contains(&pid) {
            return Err(SupervisorError::Unavailable(
                "unreadable kernel identity".to_owned(),
            ));
        }
        Ok(self.processes.get(&pid).cloned())
    }

    fn child_exited(&self, _pid: u32) -> bool {
        false
    }

    fn alive(&self, group: u32) -> Result<bool, ProbeRefused> {
        self.alive.get(&group).cloned().unwrap_or(Ok(true))
    }

    fn kill(&self, group: u32) {
        self.killed.borrow_mut().push(group);
    }

    fn owner_pid(&self) -> u32 {
        self.owner
    }

    fn now_ms(&self) -> u64 {
        0
    }
}

/// A recorded process the kernel would report.
pub fn identity(pid: u32, start: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        start: start.to_owned(),
        owner: ProcessOwner::Uid(1000),
        group: pid,
    }
}
