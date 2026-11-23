// SPDX-License-Identifier: Apache-2.0
//! Process trees by parent pid, for stops that must reach every process a
//! child started. Ports `process-tree.ts`: a capture takes each child's start
//! from the same kernel read as its parent link, and every signal is checked
//! against that start on its own, just before it is sent.

use crate::errors::SupervisorError;
use crate::signal::{PidFdTable, SignalIo, SignalName, SignalOutcome, TreeRef, signal_member};

/// The most members one capture walks; past it the stop must not report done.
pub const CAPTURE_LIMIT: usize = 16_384;
const TABLE_LIMIT: usize = 4_194_304;

/// A running process, from one kernel read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveIdentity {
    pub start: String,
    pub parent: u32,
    pub group: u32,
}

/// A captured process: the member, the parent it had then, its group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedMember {
    pub pid: u32,
    pub start: String,
    pub parent: u32,
    pub group: u32,
}

impl CapturedMember {
    /// The member as a signal target.
    pub fn as_ref(&self) -> TreeRef {
        TreeRef {
            pid: self.pid,
            start: self.start.clone(),
        }
    }
}

/// The tree seam over a listing, with injected fakes for tests.
pub trait TreeIo {
    /// The platform: trees are walked on darwin and linux only.
    fn platform(&self) -> &str;
    /// A children reader for one walk.
    fn children(&self, pid: u32) -> Vec<u32>;
    /// A running process's identity; `None` once it is gone, zombies included.
    fn identity(&self, pid: u32) -> Option<LiveIdentity>;
    /// kill(2) by pid; false when the kill threw, which reads as gone.
    fn kill(&self, pid: u32, signal: SignalName) -> bool;
    /// Linux pidfds, where available.
    fn pidfds(&self) -> Option<&dyn PidFdTable>;
    /// Sleeps between liveness polls; tests substitute a no-op.
    fn wait_ms(&self, ms: u64);
}

/// Whether this platform finds trees by parent pid.
pub fn captures_trees(platform: &str) -> bool {
    platform == "darwin" || platform == "linux"
}

/// `ps -A -o pid=,ppid=`: each process's parent. Malformed rows are skipped.
pub fn parse_process_parents(text: &str) -> Vec<(u32, u32)> {
    if text.len() > TABLE_LIMIT {
        return Vec::new();
    }
    let mut parents = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        if pid > 0 {
            parents.push((pid, ppid));
        }
    }
    parents
}

/// Every process below `roots` in the parent table, roots excluded, parents
/// before children.
pub fn descendants_of(parents: &[(u32, u32)], roots: &[u32]) -> Vec<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, parent) in parents {
        if pid == parent {
            continue;
        }
        children.entry(*parent).or_default().push(*pid);
    }
    let mut seen: std::collections::HashSet<u32> = roots.iter().copied().collect();
    let mut found = Vec::new();
    let mut queue: std::collections::VecDeque<u32> = roots.to_vec().into();
    while let Some(next) = queue.pop_front() {
        if let Some(members) = children.get(&next) {
            for child in members.clone() {
                if seen.insert(child) {
                    found.push(child);
                    queue.push_back(child);
                }
            }
        }
    }
    found
}

/// A capture: what it found, and whether it stopped at its limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    pub members: Vec<CapturedMember>,
    pub truncated: bool,
}

/// Reads one identity; unreadable (another user's) is never ours to signal.
fn read_identity(io: &dyn TreeIo, pid: u32) -> Option<LiveIdentity> {
    io.identity(pid)
}

/// Every live process below `roots` with its start identity, parents before
/// children. A child is kept only when its own parent link names the parent
/// being walked, and only while that parent is still the walked process.
pub fn capture_tree(roots: &[u32], io: &dyn TreeIo, limit: usize) -> Capture {
    if roots.is_empty() || !captures_trees(io.platform()) {
        return Capture {
            members: Vec::new(),
            truncated: false,
        };
    }
    let mut members = Vec::new();
    let mut seen: std::collections::HashSet<u32> = roots.iter().copied().collect();
    let mut queue: std::collections::VecDeque<TreeRef> = roots
        .iter()
        .filter_map(|pid| {
            read_identity(io, *pid).map(|identity| TreeRef {
                pid: *pid,
                start: identity.start,
            })
        })
        .collect();
    while let Some(parent) = queue.pop_front() {
        let mut found = Vec::new();
        for pid in io.children(parent.pid) {
            if seen.contains(&pid) {
                continue;
            }
            let Some(identity) = read_identity(io, pid) else {
                continue;
            };
            if identity.parent != parent.pid {
                continue;
            }
            found.push(CapturedMember {
                pid,
                start: identity.start,
                parent: parent.pid,
                group: identity.group,
            });
        }
        // The list named whoever holds the parent's pid: only ours if it still does.
        if read_identity(io, parent.pid)
            .as_ref()
            .map(|identity| &identity.start)
            != Some(&parent.start)
        {
            continue;
        }
        for member in found {
            if members.len() >= limit {
                return Capture {
                    members,
                    truncated: true,
                };
            }
            seen.insert(member.pid);
            queue.push_back(TreeRef {
                pid: member.pid,
                start: member.start.clone(),
            });
            members.push(member);
        }
    }
    Capture {
        members,
        truncated: false,
    }
}

/// The live identity of a process as a stop target, once it is gone `None`.
pub fn member_of(pid: u32, io: &dyn TreeIo) -> Option<TreeRef> {
    read_identity(io, pid).map(|identity| TreeRef {
        pid,
        start: identity.start,
    })
}

/// The captured members that are still the same running process.
pub fn live_members(members: &[TreeRef], io: &dyn TreeIo) -> Vec<TreeRef> {
    members
        .iter()
        .filter(|member| {
            read_identity(io, member.pid)
                .as_ref()
                .map(|identity| &identity.start)
                == Some(&member.start)
        })
        .cloned()
        .collect()
}

struct TreeSignalIo<'a> {
    io: &'a dyn TreeIo,
}

impl SignalIo for TreeSignalIo<'_> {
    fn start(&self, pid: u32) -> Option<String> {
        read_identity(self.io, pid).map(|identity| identity.start)
    }

    fn kill(&self, pid: u32, signal: SignalName) -> bool {
        self.io.kill(pid, signal)
    }

    fn pidfds(&self) -> Option<&dyn PidFdTable> {
        self.io.pidfds()
    }
}

/// Signals one member, checked on its own just before the signal goes.
pub fn signal_tree_member(member: &TreeRef, signal: SignalName, io: &dyn TreeIo) -> SignalOutcome {
    signal_member(member, signal, &TreeSignalIo { io })
}

/// Parses `SIGTERM` and `SIGKILL` for the stop path.
pub fn stop_signal(name: &str) -> Result<SignalName, SupervisorError> {
    SignalName::parse(name)
}

/// Stops the captured members still running: SIGTERM, then SIGKILL after
/// `grace_ms`. `deadline` bounds it all: past it, no round starts and no wait
/// continues. Resolves with the members still running.
pub fn stop_members(
    members: &[TreeRef],
    grace_ms: u64,
    io: &dyn TreeIo,
    deadline: Option<std::time::Instant>,
) -> Vec<TreeRef> {
    let signal = |name: SignalName| {
        for member in members {
            signal_tree_member(member, name, io);
        }
    };
    let late = || deadline.is_some_and(|end| std::time::Instant::now() >= end);
    let settle = |milliseconds: u64| {
        let mut waited = 0;
        while waited < milliseconds && !late() && !live_members(members, io).is_empty() {
            io.wait_ms(25);
            waited += 25;
        }
    };
    if live_members(members, io).is_empty() || late() {
        return live_members(members, io);
    }
    signal(SignalName::Term);
    settle(grace_ms);
    if late() {
        return live_members(members, io);
    }
    signal(SignalName::Kill);
    settle(1_000);
    live_members(members, io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Clone)]
    struct FakeProc {
        parent: u32,
        start: String,
        group: Option<u32>,
        ignores: Option<Ignore>,
        zombie: bool,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Ignore {
        Term,
        All,
    }

    type BeforeIdentity = Box<dyn Fn(&Fake, u32)>;
    type AfterSignal = Box<dyn Fn(&Fake, u32)>;
    type AfterIdentity = Box<dyn Fn(&Fake, u32, usize)>;

    struct Fake {
        table: RefCell<HashMap<u32, FakeProc>>,
        signals: RefCell<Vec<String>>,
        platform: String,
        before_identity: Option<BeforeIdentity>,
        after_signal: Option<AfterSignal>,
        after_identity: RefCell<HashMap<u32, usize>>,
        after_identity_hook: Option<AfterIdentity>,
        pidfd_enabled: bool,
        open_failure: Option<OpenBehavior>,
        pinned: RefCell<HashMap<i32, (u32, String)>>,
        next_fd: RefCell<i32>,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum OpenBehavior {
        Gone,
        Unsupported,
        Unsafe,
    }

    impl Fake {
        fn group_of(&self, pid: u32, table: &HashMap<u32, FakeProc>) -> u32 {
            let Some(row) = table.get(&pid) else {
                return pid;
            };
            if let Some(group) = row.group {
                return group;
            }
            if row.parent > 1 {
                return self.group_of(row.parent, table);
            }
            pid
        }

        /// A stand-in descriptor, never signalled through; only the pinning matters.
        #[cfg(unix)]
        fn null_fd() -> Option<crate::signal::PidFd> {
            let file = std::fs::File::open("/dev/null").ok()?;
            Some(crate::signal::PidFd::new(file.into()))
        }

        /// Off unix there is no descriptor to stand in with; the pin is logical.
        #[cfg(not(unix))]
        fn null_fd() -> Option<crate::signal::PidFd> {
            Some(crate::signal::PidFd::test())
        }
    }

    impl crate::signal::PidFdTable for Fake {
        fn open(&self, pid: u32) -> crate::signal::PidFdOpen {
            if let Some(failure) = self.open_failure {
                return match failure {
                    OpenBehavior::Gone => crate::signal::PidFdOpen::Gone,
                    OpenBehavior::Unsupported => crate::signal::PidFdOpen::Unsupported,
                    OpenBehavior::Unsafe => crate::signal::PidFdOpen::Unsafe,
                };
            }
            let Some(row) = self.table.borrow().get(&pid).cloned() else {
                return crate::signal::PidFdOpen::Gone;
            };
            let mut next = self.next_fd.borrow_mut();
            let fd = *next;
            *next += 1;
            self.pinned
                .borrow_mut()
                .insert(fd, (pid, row.start.clone()));
            match Self::null_fd() {
                Some(pinned) => crate::signal::PidFdOpen::Open(pinned),
                None => crate::signal::PidFdOpen::Unsafe,
            }
        }

        fn send(&self, _fd: &crate::signal::PidFd, signal: SignalName) -> bool {
            // The fake pins one descriptor at a time; the last open wins.
            let Some((pid, start)) = self.pinned.borrow().values().last().cloned() else {
                return false;
            };
            let table = self.table.borrow();
            if table.get(&pid).map(|row| &row.start) != Some(&start) {
                return false;
            }
            drop(table);
            self.kill(pid, signal)
        }
    }

    impl TreeIo for Fake {
        fn platform(&self) -> &str {
            &self.platform
        }

        fn children(&self, pid: u32) -> Vec<u32> {
            self.table
                .borrow()
                .iter()
                .filter(|(_, row)| row.parent == pid)
                .map(|(child, _)| *child)
                .collect()
        }

        fn identity(&self, pid: u32) -> Option<LiveIdentity> {
            if let Some(hook) = &self.before_identity {
                hook(self, pid);
            }
            let row = self.table.borrow().get(&pid).cloned()?;
            if row.zombie {
                return None;
            }
            let group = self.group_of(pid, &self.table.borrow());
            let identity = LiveIdentity {
                start: row.start.clone(),
                parent: row.parent,
                group,
            };
            if let Some(hook) = &self.after_identity_hook {
                let mut counts = self.after_identity.borrow_mut();
                let count = counts.entry(pid).or_insert(0);
                *count += 1;
                hook(self, pid, *count);
            }
            Some(identity)
        }

        fn kill(&self, pid: u32, signal: SignalName) -> bool {
            let name = match signal {
                SignalName::Term => "SIGTERM",
                SignalName::Kill => "SIGKILL",
            };
            let mut table = self.table.borrow_mut();
            let Some(row) = table.get(&pid).cloned() else {
                return false;
            };
            self.signals
                .borrow_mut()
                .push(format!("{name} {pid}:{}", row.start));
            let end = match row.ignores {
                Some(Ignore::All) => false,
                Some(Ignore::Term) => signal != SignalName::Term,
                None => true,
            };
            if end {
                table.remove(&pid);
                for child in table.values_mut() {
                    if child.parent == pid {
                        child.parent = 1;
                    }
                }
            }
            drop(table);
            if let Some(hook) = &self.after_signal {
                hook(self, pid);
            }
            true
        }

        fn pidfds(&self) -> Option<&dyn PidFdTable> {
            if self.pidfd_enabled { Some(self) } else { None }
        }

        fn wait_ms(&self, _ms: u64) {}
    }

    fn machine(rows: &[(u32, u32, &str)]) -> Fake {
        Fake {
            table: RefCell::new(
                rows.iter()
                    .map(|(pid, parent, start)| {
                        (
                            *pid,
                            FakeProc {
                                parent: *parent,
                                start: (*start).to_owned(),
                                group: None,
                                ignores: None,
                                zombie: false,
                            },
                        )
                    })
                    .collect(),
            ),
            signals: RefCell::new(Vec::new()),
            platform: "darwin".to_owned(),
            before_identity: None,
            after_signal: None,
            after_identity: RefCell::new(HashMap::new()),
            after_identity_hook: None,
            pidfd_enabled: false,
            open_failure: None,
            pinned: RefCell::new(HashMap::new()),
            next_fd: RefCell::new(3),
        }
    }

    fn member(pid: u32, start: &str) -> TreeRef {
        TreeRef {
            pid,
            start: start.to_owned(),
        }
    }

    #[test]
    fn parents_survive_malformed_rows() {
        assert_eq!(
            parse_process_parents("    1     0\n  326     1\n garbage\n  400   326\n"),
            vec![(1, 0), (326, 1), (400, 326)]
        );
        assert!(parse_process_parents(&"x".repeat(TABLE_LIMIT + 1)).is_empty());
    }

    #[test]
    fn descendants_stay_parents_before_children() {
        assert_eq!(
            descendants_of(&[(200, 100), (300, 200), (301, 300)], &[100]),
            vec![200, 300, 301]
        );
        assert!(descendants_of(&[(200, 100)], &[]).is_empty());
    }

    #[test]
    fn tree_includes_grandchildren_wherever_their_group_is() {
        let fake = machine(&[
            (1, 0, "init"),
            (100, 1, "daemon"),
            (200, 100, "app-server"),
            (300, 200, "detached"),
            (301, 300, "detached-child"),
            (900, 1, "other-daemon"),
            (901, 900, "other-child"),
        ]);
        // The detached child left the group: give it a session of its own.
        if let Some(row) = fake.table.borrow_mut().get_mut(&300) {
            row.group = Some(300);
        }
        if let Some(row) = fake.table.borrow_mut().get_mut(&200) {
            row.group = Some(200);
        }
        assert_eq!(
            capture_tree(&[100], &fake, CAPTURE_LIMIT),
            Capture {
                members: vec![
                    CapturedMember {
                        pid: 200,
                        start: "app-server".to_owned(),
                        parent: 100,
                        group: 200,
                    },
                    CapturedMember {
                        pid: 300,
                        start: "detached".to_owned(),
                        parent: 200,
                        group: 300,
                    },
                    CapturedMember {
                        pid: 301,
                        start: "detached-child".to_owned(),
                        parent: 300,
                        group: 300,
                    },
                ],
                truncated: false,
            }
        );
    }

    #[test]
    fn windows_finds_no_trees_by_parent_pid() {
        let mut fake = machine(&[(100, 1, "a"), (200, 100, "b")]);
        fake.platform = "win32".to_owned();
        assert!(
            capture_tree(&[100], &fake, CAPTURE_LIMIT)
                .members
                .is_empty()
        );
    }

    #[test]
    fn reused_pid_before_its_identity_read_is_not_a_member() {
        let mut fake = machine(&[(100, 1, "daemon"), (200, 100, "app-server")]);
        // Between the child list and the identity read, 200 exits and a stranger takes its pid.
        fake.before_identity = Some(Box::new(|fake, pid| {
            let current = fake.table.borrow().get(&200).map(|row| row.start.clone());
            if pid == 200 && current.as_deref() == Some("app-server") {
                fake.table.borrow_mut().remove(&200);
                fake.table.borrow_mut().insert(
                    200,
                    FakeProc {
                        parent: 1,
                        start: "stranger".to_owned(),
                        group: None,
                        ignores: None,
                        zombie: false,
                    },
                );
            }
        }));
        assert!(
            capture_tree(&[100], &fake, CAPTURE_LIMIT)
                .members
                .is_empty()
        );
    }

    #[test]
    fn children_listed_under_a_reused_pid_are_dropped() {
        let mut fake = machine(&[(100, 1, "daemon"), (200, 100, "app-server")]);
        fake.table.borrow_mut().insert(
            300,
            FakeProc {
                parent: 200,
                start: "shell".to_owned(),
                group: None,
                ignores: None,
                zombie: false,
            },
        );
        fake.before_identity = Some(Box::new(|fake, pid| {
            // The app-server exits after its children were listed, and a stranger reuses its pid
            // with a child of its own the list already named.
            if pid == 300
                && fake.table.borrow().get(&200).map(|row| row.start.as_str()) == Some("app-server")
            {
                fake.table.borrow_mut().remove(&200);
                fake.table.borrow_mut().insert(
                    200,
                    FakeProc {
                        parent: 1,
                        start: "stranger".to_owned(),
                        group: None,
                        ignores: None,
                        zombie: false,
                    },
                );
                fake.table.borrow_mut().insert(
                    300,
                    FakeProc {
                        parent: 200,
                        start: "stranger-child".to_owned(),
                        group: None,
                        ignores: None,
                        zombie: false,
                    },
                );
            }
        }));
        // The app-server was the daemon's child when read; nothing the reused pid listed is kept.
        assert_eq!(
            capture_tree(&[100], &fake, CAPTURE_LIMIT)
                .members
                .iter()
                .map(|member| member.start.clone())
                .collect::<Vec<_>>(),
            vec!["app-server".to_owned()]
        );
    }

    #[test]
    fn capture_at_its_limit_says_truncated() {
        let fake = machine(&[
            (100, 1, "daemon"),
            (200, 100, "a"),
            (201, 100, "b"),
            (202, 100, "c"),
        ]);
        let capture = capture_tree(&[100], &fake, 2);
        assert!(capture.truncated);
        assert_eq!(capture.members.len(), 2);
        assert!(!capture_tree(&[100], &fake, 3).truncated);
    }

    #[test]
    fn stop_checks_each_member_just_before_its_signal() {
        let mut fake = machine(&[(200, 1, "first"), (300, 1, "second")]);
        fake.after_signal = Some(Box::new(|fake, pid| {
            // While the batch runs, 300 exits and its pid goes to an unrelated process.
            if pid == 200
                && fake.table.borrow().get(&300).map(|row| row.start.as_str()) == Some("second")
            {
                fake.table.borrow_mut().remove(&300);
                fake.table.borrow_mut().insert(
                    300,
                    FakeProc {
                        parent: 1,
                        start: "stranger".to_owned(),
                        group: None,
                        ignores: None,
                        zombie: false,
                    },
                );
            }
        }));
        stop_members(
            &[member(200, "first"), member(300, "second")],
            500,
            &fake,
            None,
        );
        assert_eq!(
            fake.signals.borrow().clone(),
            vec!["SIGTERM 200:first".to_owned()]
        );
        assert_eq!(
            fake.table.borrow().get(&300).map(|row| row.start.clone()),
            Some("stranger".to_owned())
        );
    }

    #[test]
    fn pidfd_pins_the_checked_process_so_a_reused_pid_is_never_signalled() {
        let mut fake = machine(&[(300, 1, "second")]);
        fake.pidfd_enabled = true;
        fake.after_identity_hook = Some(Box::new(|fake, pid, reads| {
            // 300 exits and a stranger takes its pid right after the third identity read.
            if pid == 300 && reads == 3 {
                fake.table.borrow_mut().remove(&300);
                fake.table.borrow_mut().insert(
                    300,
                    FakeProc {
                        parent: 1,
                        start: "stranger".to_owned(),
                        group: None,
                        ignores: None,
                        zombie: false,
                    },
                );
            }
        }));
        stop_members(&[member(300, "second")], 500, &fake, None);
        assert!(fake.signals.borrow().is_empty());
        assert_eq!(
            fake.table.borrow().get(&300).map(|row| row.start.clone()),
            Some("stranger".to_owned())
        );
    }

    #[test]
    fn gone_pidfd_open_reads_gone_without_signalling() {
        let mut fake = machine(&[(300, 1, "provider")]);
        fake.pidfd_enabled = true;
        fake.open_failure = Some(OpenBehavior::Gone);
        let left = stop_members(&[member(300, "provider")], 500, &fake, None);
        assert!(fake.signals.borrow().is_empty());
        assert_eq!(left, vec![member(300, "provider")]);
    }

    #[test]
    fn undescriptored_pidfd_reports_unsafe_and_runs_no_signal() {
        let mut fake = machine(&[(300, 1, "provider")]);
        fake.pidfd_enabled = true;
        fake.open_failure = Some(OpenBehavior::Unsafe);
        let left = stop_members(&[member(300, "provider")], 500, &fake, None);
        assert!(fake.signals.borrow().is_empty());
        assert_eq!(left, vec![member(300, "provider")]);
    }

    #[test]
    fn kernel_without_pidfds_signals_the_pid_directly() {
        let mut fake = machine(&[(300, 1, "provider")]);
        fake.pidfd_enabled = true;
        fake.open_failure = Some(OpenBehavior::Unsupported);
        let left = stop_members(&[member(300, "provider")], 500, &fake, None);
        assert!(left.is_empty());
        assert_eq!(
            fake.signals.borrow().clone(),
            vec!["SIGTERM 300:provider".to_owned()]
        );
    }

    #[test]
    fn stop_past_its_deadline_sends_no_signal() {
        let fake = machine(&[(300, 1, "provider")]);
        let left = stop_members(
            &[member(300, "provider")],
            500,
            &fake,
            Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
        );
        assert!(fake.signals.borrow().is_empty());
        assert_eq!(left, vec![member(300, "provider")]);
    }

    #[test]
    fn stubborn_member_is_killed_and_unkillable_is_reported() {
        let fake = machine(&[(200, 1, "stubborn"), (300, 1, "unkillable")]);
        if let Some(row) = fake.table.borrow_mut().get_mut(&200) {
            row.ignores = Some(Ignore::Term);
        }
        if let Some(row) = fake.table.borrow_mut().get_mut(&300) {
            row.ignores = Some(Ignore::All);
        }
        let survivors = stop_members(
            &[member(200, "stubborn"), member(300, "unkillable")],
            500,
            &fake,
            None,
        );
        assert_eq!(survivors, vec![member(300, "unkillable")]);
        assert_eq!(
            fake.signals.borrow().clone(),
            vec![
                "SIGTERM 200:stubborn".to_owned(),
                "SIGTERM 300:unkillable".to_owned(),
                "SIGKILL 200:stubborn".to_owned(),
                "SIGKILL 300:unkillable".to_owned(),
            ]
        );
    }

    #[test]
    fn zombie_counts_as_stopped() {
        let fake = machine(&[(200, 1, "done")]);
        if let Some(row) = fake.table.borrow_mut().get_mut(&200) {
            row.zombie = true;
        }
        assert!(stop_members(&[member(200, "done")], 500, &fake, None).is_empty());
        assert!(fake.signals.borrow().is_empty());
    }
}
