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
mod tests;
