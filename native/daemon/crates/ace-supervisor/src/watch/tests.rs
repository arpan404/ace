// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::signal::{PidFdTable, SignalName};
use crate::tree::{LiveIdentity, TreeIo};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone)]
struct Proc {
    parent: u32,
    start: String,
    group: Option<u32>,
    zombie: bool,
}

struct Machine {
    table: HashMap<u32, Proc>,
}

impl Machine {
    fn group_of(&self, pid: u32) -> u32 {
        let Some(row) = self.table.get(&pid) else {
            return pid;
        };
        if let Some(group) = row.group {
            return group;
        }
        if row.parent > 1 {
            return self.group_of(row.parent);
        }
        pid
    }

    fn end(&mut self, pid: u32) {
        self.table.remove(&pid);
        for row in self.table.values_mut() {
            if row.parent == pid {
                row.parent = 1;
            }
        }
    }
}

/// The tree side over shared machine state.
struct SharedTree {
    machine: Rc<RefCell<Machine>>,
    signals: Rc<RefCell<Vec<String>>>,
}

impl TreeIo for SharedTree {
    fn platform(&self) -> &str {
        "darwin"
    }

    fn children(&self, pid: u32) -> Vec<u32> {
        self.machine
            .borrow()
            .table
            .iter()
            .filter(|(_, row)| row.parent == pid)
            .map(|(child, _)| *child)
            .collect()
    }

    fn identity(&self, pid: u32) -> Option<LiveIdentity> {
        let machine = self.machine.borrow();
        let row = machine.table.get(&pid)?;
        if row.zombie {
            return None;
        }
        Some(LiveIdentity {
            start: row.start.clone(),
            parent: row.parent,
            group: machine.group_of(pid),
        })
    }

    fn kill(&self, pid: u32, signal: SignalName) -> bool {
        let name = match signal {
            SignalName::Term => "SIGTERM",
            SignalName::Kill => "SIGKILL",
        };
        let mut machine = self.machine.borrow_mut();
        let Some(row) = machine.table.get(&pid).cloned() else {
            return false;
        };
        self.signals
            .borrow_mut()
            .push(format!("{name} {pid}:{}", row.start));
        machine.end(pid);
        true
    }

    fn pidfds(&self) -> Option<&dyn PidFdTable> {
        None
    }

    fn wait_ms(&self, _ms: u64) {}
}

struct Journal {
    rows: Rc<RefCell<HashMap<u32, String>>>,
}

impl WatchJournal for Journal {
    fn record(&mut self, members: &[TreeRef]) {
        for member in members {
            self.rows
                .borrow_mut()
                .insert(member.pid, member.start.clone());
        }
    }

    fn forget(&mut self, members: &[TreeRef]) {
        for member in members {
            self.rows.borrow_mut().remove(&member.pid);
        }
    }
}

struct Reaper {
    daemon: u32,
    machine: Rc<RefCell<Machine>>,
    reaped: Rc<RefCell<Vec<u32>>>,
}

impl WatchReaper for Reaper {
    fn myself(&self) -> (u32, u32) {
        (self.daemon, self.daemon)
    }

    fn zombies(&self) -> Vec<WatchZombie> {
        self.machine
            .borrow()
            .table
            .iter()
            .filter(|(_, row)| row.parent == self.daemon && row.zombie)
            .map(|(pid, row)| WatchZombie {
                pid: *pid,
                group: row.group.unwrap_or(self.daemon),
                start: row.start.clone(),
            })
            .collect()
    }

    fn reap(&mut self, pid: u32) -> bool {
        self.reaped.borrow_mut().push(pid);
        self.machine.borrow_mut().table.remove(&pid);
        true
    }
}

struct Driver {
    tree: SharedTree,
    leaders: Rc<RefCell<Vec<u32>>>,
    journal: Option<Journal>,
    reaper: Option<Reaper>,
    known_limit: Option<usize>,
    reports: Rc<RefCell<Vec<String>>>,
}

impl WatchIo for Driver {
    fn tree(&self) -> &dyn TreeIo {
        &self.tree
    }

    fn leaders(&self) -> Vec<u32> {
        self.leaders.borrow().clone()
    }

    fn reaper(&mut self) -> Option<&mut dyn WatchReaper> {
        self.reaper
            .as_mut()
            .map(|reaper| reaper as &mut dyn WatchReaper)
    }

    fn journal(&mut self) -> Option<&mut dyn WatchJournal> {
        self.journal
            .as_mut()
            .map(|journal| journal as &mut dyn WatchJournal)
    }

    fn report(&mut self, error: String) {
        self.reports.borrow_mut().push(error);
    }

    fn known_limit(&self) -> usize {
        self.known_limit.unwrap_or(KNOWN_LIMIT)
    }
}

struct Harness {
    machine: Rc<RefCell<Machine>>,
    signals: Rc<RefCell<Vec<String>>>,
    rows: Rc<RefCell<HashMap<u32, String>>>,
    reaped: Rc<RefCell<Vec<u32>>>,
    leaders: Rc<RefCell<Vec<u32>>>,
    reports: Rc<RefCell<Vec<String>>>,
    known_limit: std::cell::Cell<Option<usize>>,
    with_reaper: std::cell::Cell<bool>,
}

impl Harness {
    fn build(rows: &[(u32, u32, &str)], leaders: &[u32]) -> Self {
        Self {
            machine: Rc::new(RefCell::new(Machine {
                table: rows
                    .iter()
                    .map(|(pid, parent, start)| {
                        (
                            *pid,
                            Proc {
                                parent: *parent,
                                start: (*start).to_owned(),
                                group: None,
                                zombie: false,
                            },
                        )
                    })
                    .collect(),
            })),
            signals: Rc::new(RefCell::new(Vec::new())),
            rows: Rc::new(RefCell::new(HashMap::new())),
            reaped: Rc::new(RefCell::new(Vec::new())),
            leaders: Rc::new(RefCell::new(leaders.to_vec())),
            reports: Rc::new(RefCell::new(Vec::new())),
            known_limit: std::cell::Cell::new(None),
            with_reaper: std::cell::Cell::new(false),
        }
    }

    fn watch(&self) -> ProcessWatch<Driver> {
        ProcessWatch::new(Driver {
            tree: SharedTree {
                machine: Rc::clone(&self.machine),
                signals: Rc::clone(&self.signals),
            },
            leaders: Rc::clone(&self.leaders),
            journal: Some(Journal {
                rows: Rc::clone(&self.rows),
            }),
            reaper: self.with_reaper.get().then(|| Reaper {
                daemon: 100,
                machine: Rc::clone(&self.machine),
                reaped: Rc::clone(&self.reaped),
            }),
            known_limit: self.known_limit.get(),
            reports: Rc::clone(&self.reports),
        })
    }
}

#[test]
fn watch_keeps_an_orphan_it_saw_while_its_parent_lived() {
    let harness = Harness::build(&[(200, 100, "probe"), (300, 200, "sleep")], &[200]);
    if let Some(row) = harness.machine.borrow_mut().table.get_mut(&200) {
        row.group = Some(200);
    }
    if let Some(row) = harness.machine.borrow_mut().table.get_mut(&300) {
        row.group = Some(300);
    }
    let mut watch = harness.watch();
    assert!(watch.tick());
    // Outside the probe's group already: recorded for the next start.
    assert_eq!(
        harness.rows.borrow().clone(),
        HashMap::from([(300, "sleep".to_owned())])
    );
    harness.machine.borrow_mut().end(200);
    // Its parent is gone and it belongs to init; the watch still knows it.
    assert!(watch.tick());
    assert_eq!(
        watch.members(),
        vec![TreeRef {
            pid: 300,
            start: "sleep".to_owned(),
        }]
    );
    harness.machine.borrow_mut().end(300);
    harness.leaders.borrow_mut().clear();
    assert!(!watch.tick());
    assert!(watch.members().is_empty());
    assert!(harness.rows.borrow().is_empty());
}

#[test]
fn watch_forgets_ended_and_reused_pids_but_keeps_learning() {
    let harness = Harness::build(
        &[
            (200, 100, "leader"),
            (300, 200, "first"),
            (301, 200, "second"),
        ],
        &[200],
    );
    for pid in [200, 300, 301] {
        if let Some(row) = harness.machine.borrow_mut().table.get_mut(&pid) {
            row.group = Some(pid);
        }
    }
    // Room for two: what it remembers about ended processes must not use it up.
    harness.known_limit.set(Some(2));
    let mut watch = harness.watch();
    watch.tick();
    harness.machine.borrow_mut().end(300);
    harness.machine.borrow_mut().end(301);
    // 300's pid goes to a stranger; a new orphan-to-be starts under the leader.
    harness.machine.borrow_mut().table.insert(
        300,
        Proc {
            parent: 1,
            start: "stranger".to_owned(),
            group: None,
            zombie: false,
        },
    );
    watch.tick();
    harness.machine.borrow_mut().table.insert(
        302,
        Proc {
            parent: 200,
            start: "third".to_owned(),
            group: Some(302),
            zombie: false,
        },
    );
    watch.tick();
    harness.machine.borrow_mut().end(200);
    watch.tick();
    // The stranger is never taken for the old 300; the new orphan is still known.
    assert_eq!(
        watch.members(),
        vec![TreeRef {
            pid: 302,
            start: "third".to_owned(),
        }]
    );
}

#[test]
fn watch_reaps_an_adopted_zombie_once() {
    let harness = Harness::build(&[(200, 100, "app-server"), (300, 200, "shell")], &[200]);
    harness.with_reaper.set(true);
    if let Some(row) = harness.machine.borrow_mut().table.get_mut(&200) {
        row.group = Some(200);
    }
    if let Some(row) = harness.machine.borrow_mut().table.get_mut(&300) {
        row.group = Some(300);
    }
    let mut watch = harness.watch();
    watch.tick();
    // The app-server's shell is adopted by the daemon (a subreaper) and exits.
    if let Some(shell) = harness.machine.borrow_mut().table.get_mut(&300) {
        shell.parent = 100;
        shell.zombie = true;
    }
    watch.tick();
    watch.tick();
    assert_eq!(harness.reaped.borrow().clone(), vec![300]);
}

#[test]
fn watch_never_reaps_the_runtime_child_that_reused_a_pid() {
    let harness = Harness::build(&[(200, 100, "app-server"), (300, 200, "shell")], &[200]);
    harness.with_reaper.set(true);
    let mut watch = harness.watch();
    watch.tick();
    // The shell exits and its own parent reaps it; later the runtime
    // spawns a child on the same pid, which exits and waits to be reaped.
    harness.machine.borrow_mut().end(300);
    harness.machine.borrow_mut().table.insert(
        300,
        Proc {
            parent: 100,
            start: "bun-child".to_owned(),
            group: Some(300),
            zombie: true,
        },
    );
    watch.tick();
    assert!(harness.reaped.borrow().is_empty());
    // Nor once the stale record would have aged.
    watch.tick();
    assert!(harness.reaped.borrow().is_empty());
    assert_eq!(
        harness
            .machine
            .borrow()
            .table
            .get(&300)
            .map(|row| row.start.clone()),
        Some("bun-child".to_owned())
    );
}
