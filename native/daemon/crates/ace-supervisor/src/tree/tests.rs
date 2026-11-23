// SPDX-License-Identifier: Apache-2.0

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

mod stop;
