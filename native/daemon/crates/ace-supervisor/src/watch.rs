// SPDX-License-Identifier: Apache-2.0
//! A snapshot of the owned trees every few seconds, so a shutdown finds
//! orphans whose parents exited and Linux reaps adopted zombies. Ports
//! `process-watch.ts`: the work follows the owned trees, never the machine.

use crate::signal::{SignalOutcome, TreeRef};
use crate::tree::{Capture, TreeIo, capture_tree, live_members, signal_tree_member};
use std::collections::{HashMap, HashSet};

/// Between snapshots. An orphan made and orphaned again inside one is unseen.
pub const WATCH_INTERVAL_MS: u64 = 3_000;
const KNOWN_LIMIT: usize = 4_096;

/// What the watch knows of a process: start, first parent, group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownProcess {
    pub start: String,
    pub parent: u32,
    pub group: u32,
}

/// Members that left their tree, for the next start's sweep.
pub trait WatchJournal {
    /// Remembers members that left their group or tree.
    fn record(&mut self, members: &[TreeRef]);
    /// Forgets members that are gone.
    fn forget(&mut self, members: &[TreeRef]);
}

/// One of the daemon's zombie children, with its group and start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchZombie {
    pub pid: u32,
    pub group: u32,
    pub start: String,
}

/// The Linux reaper side: the daemon's pid and group, its zombies, a reap.
pub trait WatchReaper {
    /// This daemon's pid and process group.
    fn myself(&self) -> (u32, u32);
    /// The daemon's zombie children now.
    fn zombies(&self) -> Vec<WatchZombie>;
    /// Reaps one zombie; true when it was reaped.
    fn reap(&mut self, pid: u32) -> bool;
}

/// What the watch is told about the world, with injected fakes for tests.
pub trait WatchIo {
    /// The tree side: capture, liveness, signalling.
    fn tree(&self) -> &dyn TreeIo;
    /// The leaders of the process groups owned now.
    fn leaders(&self) -> Vec<u32>;
    /// Whether the platform supports adoption proof (Linux subreaper).
    fn reaper(&mut self) -> Option<&mut dyn WatchReaper>;
    /// The journal, when escapees are recorded.
    fn journal(&mut self) -> Option<&mut dyn WatchJournal>;
    /// Heard with the pids a tick learned of.
    fn learned(&mut self, _pids: &[u32]) {}
    /// Reports a tick failure; the tick still counts as busy.
    fn report(&mut self, _error: String) {}
    /// How many processes the watch remembers at most.
    fn known_limit(&self) -> usize {
        KNOWN_LIMIT
    }
}

/// The watch over the owned trees.
pub struct ProcessWatch<I> {
    io: I,
    known: HashMap<u32, KnownProcess>,
    journaled: HashMap<u32, String>,
    truncation_reported: bool,
    full: bool,
}

impl<I: WatchIo> ProcessWatch<I> {
    /// Starts watching; the driver calls `tick` on its interval.
    pub fn new(io: I) -> Self {
        Self {
            io,
            known: HashMap::new(),
            journaled: HashMap::new(),
            truncation_reported: false,
            full: false,
        }
    }

    /// One snapshot. Returns whether anything is still worth watching.
    pub fn tick(&mut self) -> bool {
        let leaders = self.io.leaders();
        let groups: HashSet<u32> = leaders.iter().copied().collect();
        let mut seen = HashSet::new();
        let capture: Capture = capture_tree(&leaders, self.io.tree(), crate::tree::CAPTURE_LIMIT);
        if capture.truncated && !self.truncation_reported {
            self.truncation_reported = true;
            self.io
                .report("The owned process trees outgrew one snapshot; some are unseen".to_owned());
        }
        let mut fresh = Vec::new();
        for member in &capture.members {
            seen.insert(member.pid);
            let same = self
                .known
                .get(&member.pid)
                .is_some_and(|known| known.start == member.start);
            let stale = self.known.contains_key(&member.pid) && !same;
            if !same {
                fresh.push(member.pid);
            }
            // A reused pid is a new process: what was known no longer holds.
            if stale {
                self.known.remove(&member.pid);
            }
            if !self.known.contains_key(&member.pid) && self.known.len() >= self.io.known_limit() {
                self.full = true;
                continue;
            }
            let parent = self
                .known
                .get(&member.pid)
                .filter(|known| known.start == member.start)
                .map(|known| known.parent)
                .unwrap_or(member.parent);
            self.known.insert(
                member.pid,
                KnownProcess {
                    start: member.start.clone(),
                    parent,
                    group: member.group,
                },
            );
        }
        // Prune first, by pid AND start; only then does evidence move on.
        let zombies = self
            .io
            .reaper()
            .map(|reaper| reaper.zombies())
            .unwrap_or_default();
        let dead: HashMap<u32, String> = zombies
            .iter()
            .map(|zombie| (zombie.pid, zombie.start.clone()))
            .collect();
        let mut keep = Vec::new();
        let mut drop_pids = Vec::new();
        for (pid, known) in &self.known {
            let member = TreeRef {
                pid: *pid,
                start: known.start.clone(),
            };
            if live_members(std::slice::from_ref(&member), self.io.tree()).is_empty() {
                if dead.get(pid) != Some(&known.start) {
                    drop_pids.push(*pid);
                }
            } else if !seen.contains(pid) || !groups.contains(&known.group) {
                keep.push(member);
            }
        }
        for pid in drop_pids {
            self.known.remove(&pid);
        }
        self.reap_adopted(&zombies, &groups);
        self.journal(&keep);
        if !fresh.is_empty() {
            self.io.learned(&fresh);
        }
        !leaders.is_empty() || !keep.is_empty()
    }

    /// Whether every snapshot so far saw its trees whole and remembered all.
    pub fn complete(&self) -> bool {
        !self.truncation_reported && !self.full
    }

    /// Every known process still running, whatever its parent is now.
    pub fn members(&self) -> Vec<TreeRef> {
        let members: Vec<TreeRef> = self
            .known
            .iter()
            .map(|(pid, known)| TreeRef {
                pid: *pid,
                start: known.start.clone(),
            })
            .collect();
        live_members(&members, self.io.tree())
    }

    fn journal(&mut self, keep: &[TreeRef]) {
        let Some(journal) = self.io.journal() else {
            return;
        };
        let wanted: HashMap<u32, &str> = keep
            .iter()
            .map(|member| (member.pid, member.start.as_str()))
            .collect();
        let added: Vec<TreeRef> = keep
            .iter()
            .filter(|member| {
                self.journaled.get(&member.pid).map(String::as_str) != Some(member.start.as_str())
            })
            .cloned()
            .collect();
        let gone: Vec<TreeRef> = self
            .journaled
            .iter()
            .filter(|(pid, start)| wanted.get(pid).copied() != Some(start.as_str()))
            .map(|(pid, start)| TreeRef {
                pid: *pid,
                start: (*start).clone(),
            })
            .collect();
        if gone.is_empty() && added.is_empty() {
            return;
        }
        journal.forget(&gone);
        journal.record(&added);
        for member in &gone {
            self.journaled.remove(&member.pid);
        }
        for member in &added {
            self.journaled.insert(member.pid, member.start.clone());
        }
    }

    fn reap_adopted(&mut self, zombies: &[WatchZombie], owned: &HashSet<u32>) {
        let Some(reaper) = self.io.reaper() else {
            return;
        };
        if zombies.is_empty() {
            return;
        }
        let (daemon_pid, _) = reaper.myself();
        let mut reaped = Vec::new();
        for zombie in zombies {
            if owned.contains(&zombie.pid) {
                continue;
            }
            let seen = self.known.get(&zombie.pid);
            let proven =
                seen.is_some_and(|known| known.start == zombie.start && known.parent != daemon_pid);
            if proven && reaper.reap(zombie.pid) {
                reaped.push(zombie.pid);
            }
        }
        for pid in reaped {
            self.known.remove(&pid);
        }
    }
}

/// Signals one member through the watch's tree, checked just before it goes.
pub fn watch_signal(
    member: &TreeRef,
    signal: crate::signal::SignalName,
    tree: &dyn TreeIo,
) -> SignalOutcome {
    signal_tree_member(member, signal, tree)
}

#[cfg(test)]
mod tests {
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
}
