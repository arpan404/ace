//! Ending everything a shell command started (ADR 0142), on macOS and Linux. Killing the
//! command's process group is not enough: a child can start a session of its own (`setsid`) and
//! leave the group, and once its parent exits it is reparented away from the command.
//!
//! **Which processes.** The command's leader while it is not yet reaped, the live descendants of
//! anything selected by parent chain, the members of the command's process group (on macOS,
//! only those started while the command ran), and on Linux, where Spade is a child subreaper,
//! orphans it adopted (parent is Spade) that carry this run's mark (`SPADE_RUN=<random>`, which
//! everything the command starts inherits). The mark alone never selects a process.
//!
//! **Whose they are.** A process is recorded with its identity when found (on Linux a pidfd,
//! which every signal goes through; on macOS its start time, checked again right before every
//! signal, and skipped on a mismatch), so a pid reused by another process is never signalled.
//! The leader is never signalled by number once it is reaped.
//!
//! **How.** Everything found is stopped (`SIGSTOP`), and the look is repeated until no new
//! process turns up and each one found is seen stopped or gone. Then all of it is killed. When
//! that doesn't settle within a few passes, what is known is killed anyway and the end is
//! reported incomplete: the caller says some processes may still run.
//!
//! **The limits.** On macOS, a process that detached and was reparented away before the end (a
//! daemon left by a command that finished) is not found. On Linux, one that also cleared its
//! environment and started another program before its parent exited is not found either.

use std::collections::{BTreeMap, BTreeSet};

use rustix::process::Signal;

/// The variable each command carries, so what it leaves behind can be told apart.
pub(super) const MARK: &str = "SPADE_RUN";

/// How many times the processes are looked at while they are being stopped.
const LOOKS: usize = 8;

/// One process as a look found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Found {
    pub pid: i32,
    pub parent: i32,
    pub group: i32,
    /// When it started, in the platform's own unit (clock ticks since boot on Linux, seconds
    /// since the epoch on macOS). With the pid, it names one process.
    pub started: u64,
    /// Stopped, or exited and not yet reaped.
    pub still: bool,
    /// Its environment holds this run's mark (only read on Linux).
    pub marked: bool,
}

/// The command being ended.
#[derive(Debug, Clone)]
pub(super) struct Run {
    pub leader: i32,
    pub mark: String,
    /// The leader was reaped: its number may belong to another process now.
    pub reaped: bool,
    /// When it started and ended, in seconds since the epoch, for telling its group's members
    /// from a later group that reused the number (macOS; Linux needs neither).
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub started_secs: u64,
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub ended_secs: Option<u64>,
}

/// Which of `all` belong to `run`: see the module's comment. `me` is Spade's own pid.
pub(super) fn select(all: &[Found], run: &Run, me: i32) -> BTreeSet<i32> {
    let mut chosen: BTreeSet<i32> = BTreeSet::new();
    for process in all {
        if process.pid <= 1 || process.pid == me {
            continue;
        }
        if process.pid == run.leader {
            if !run.reaped {
                chosen.insert(process.pid);
            }
            continue;
        }
        let in_group = process.group == run.leader && platform::group_member(process, run);
        let adopted = cfg!(target_os = "linux") && process.parent == me && process.marked;
        if in_group || adopted {
            chosen.insert(process.pid);
        }
    }
    // Children of anything chosen, until nothing new.
    loop {
        let more: Vec<i32> = all
            .iter()
            .filter(|p| {
                chosen.contains(&p.parent)
                    && !chosen.contains(&p.pid)
                    && p.pid != me
                    && p.pid > 1
                    && !(p.pid == run.leader && run.reaped)
            })
            .map(|p| p.pid)
            .collect();
        if more.is_empty() {
            break;
        }
        chosen.extend(more);
    }
    chosen
}

/// Whether every process in `known` is, by `now`, stopped or gone (exited, reaped, or its number
/// another process's). A stop signal sent is not proof: only a process seen stopped counts.
pub(super) fn all_still(known: &[Found], now: &[Found]) -> bool {
    known.iter().all(|then| {
        now.iter()
            .find(|p| p.pid == then.pid)
            .is_none_or(|p| !same(then, p) || p.still)
    })
}

/// Whether `now` is still the process recorded as `then`.
pub(super) fn same(then: &Found, now: &Found) -> bool {
    then.pid == now.pid && then.started == now.started
}

/// Ends `run` and everything it started. Answers whether that settled: `false` means some may
/// still run.
pub(super) fn end(run: &Run) -> bool {
    let me = rustix::process::getpid().as_raw_nonzero().get();
    let mut known: BTreeMap<i32, platform::Handle> = BTreeMap::new();
    let mut settled = false;
    for _ in 0..LOOKS {
        let all = platform::look(&run.mark);
        let chosen = select(&all, run, me);
        let mut new = false;
        for found in all.iter().filter(|p| chosen.contains(&p.pid)) {
            if known.contains_key(&found.pid) {
                continue;
            }
            if let Some(handle) = platform::Handle::of(found) {
                handle.signal(Signal::STOP);
                known.insert(found.pid, handle);
                new = true;
            }
        }
        if new {
            continue;
        }
        // Nothing new: done once each one found is seen stopped or gone.
        let again = platform::look(&run.mark);
        let found: Vec<Found> = known.values().map(|h| h.found().clone()).collect();
        if all_still(&found, &again) {
            settled = true;
            break;
        }
        // A stop takes a moment to show.
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let now = platform::look(&run.mark);
    for handle in known.values() {
        // A process gone since it was found may have had its number taken: never signalled.
        if now.iter().any(|p| same(handle.found(), p)) {
            handle.signal(Signal::KILL);
        }
    }
    platform::reap(known.values().map(|h| h.found().pid), run, me);
    if !settled {
        tracing::warn!(
            leader = run.leader,
            "a command's processes did not all stop; some may still run"
        );
    }
    settled
}

/// Makes Spade the child subreaper (Linux), so what a command leaves behind is reparented to
/// Spade and stays findable. Elsewhere nothing.
pub fn adopt_orphans() {
    platform::adopt_orphans();
}

#[cfg(target_os = "linux")]
mod platform {
    use std::os::fd::OwnedFd;

    use rustix::process::{Pid, PidfdFlags, Signal, WaitOptions, pidfd_open, pidfd_send_signal};

    use super::{Found, Run};

    /// Every process now, from `/proc`.
    pub(super) fn look(mark: &str) -> Vec<Found> {
        let needle = format!("{}={mark}", super::MARK);
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let pid = entry.file_name().to_str()?.parse::<i32>().ok()?;
                let mut found = stat(pid)?;
                found.marked = std::fs::read(entry.path().join("environ"))
                    .is_ok_and(|env| env.split(|b| *b == 0).any(|v| v == needle.as_bytes()));
                Some(found)
            })
            .collect()
    }

    /// One process's `/proc/<pid>/stat`: state, parent, group and start time (after the name,
    /// which may hold spaces and parentheses).
    fn stat(pid: i32) -> Option<Found> {
        let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (_, rest) = text.rsplit_once(')')?;
        let fields: Vec<&str> = rest.split_whitespace().collect();
        Some(Found {
            pid,
            parent: fields.get(1)?.parse().ok()?,
            group: fields.get(2)?.parse().ok()?,
            started: fields.get(19)?.parse().ok()?,
            still: matches!(*fields.first()?, "T" | "t" | "Z" | "X"),
            marked: false,
        })
    }

    /// Members of the command's group: on Linux the group can't be another's while one of its
    /// members lives, and Spade adopts the rest.
    pub(super) fn group_member(_process: &Found, _run: &Run) -> bool {
        true
    }

    /// A pidfd for the process found, opened only if it is still that process.
    pub(super) struct Handle {
        found: Found,
        fd: OwnedFd,
    }

    impl Handle {
        pub(super) fn of(found: &Found) -> Option<Self> {
            let fd = pidfd_open(Pid::from_raw(found.pid)?, PidfdFlags::empty()).ok()?;
            // Opened after the look: still the same process?
            let now = stat(found.pid)?;
            super::same(found, &now).then(|| Self {
                found: found.clone(),
                fd,
            })
        }

        pub(super) fn found(&self) -> &Found {
            &self.found
        }

        /// Through the pidfd, so it can only reach this process.
        pub(super) fn signal(&self, sig: Signal) {
            let _ = pidfd_send_signal(&self.fd, sig);
        }
    }

    pub(super) fn adopt_orphans() {
        if let Err(error) = rustix::process::set_child_subreaper(Pid::from_raw(1)) {
            tracing::warn!(%error, "Spade could not become a child subreaper");
        }
    }

    /// Reaps the killed processes Spade adopted, each by its own pid: never `waitpid(-1)`, which
    /// could take a child Spade started itself. The leader is tokio's to reap.
    pub(super) fn reap(killed: impl Iterator<Item = i32>, run: &Run, me: i32) {
        let adopted: Vec<i32> = killed
            .filter(|pid| *pid != run.leader)
            .filter(|pid| stat(*pid).is_some_and(|p| p.parent == me))
            .collect();
        for _ in 0..20 {
            let mut left = false;
            for pid in &adopted {
                let Some(pid) = Pid::from_raw(*pid) else {
                    continue;
                };
                if let Ok(None) = rustix::process::waitpid(Some(pid), WaitOptions::NOHANG) {
                    left = true;
                }
            }
            if !left {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use rustix::process::{Pid, Signal, kill_process};

    use super::{Found, Run};

    const COLUMNS: [&str; 10] = [
        "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "etime=",
    ];

    /// Every process now, from `ps`: pid, parent, group, state and how long it has run, turned
    /// into its start in seconds since the epoch. The mark is never read here (macOS shows no
    /// other process's environment).
    pub(super) fn look(_mark: &str) -> Vec<Found> {
        ps(&["-ax"])
    }

    fn ps(which: &[&str]) -> Vec<Found> {
        let Ok(output) = std::process::Command::new("/bin/ps")
            .args(which)
            .args(COLUMNS)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        else {
            return Vec::new();
        };
        let now = now_secs();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| parse(line, now))
            .collect()
    }

    fn parse(line: &str, now: u64) -> Option<Found> {
        let mut fields = line.split_whitespace();
        let pid = fields.next()?.parse().ok()?;
        let parent = fields.next()?.parse().ok()?;
        let group = fields.next()?.parse().ok()?;
        let state = fields.next()?;
        let elapsed = elapsed_secs(fields.next()?)?;
        Some(Found {
            pid,
            parent,
            group,
            started: now.saturating_sub(elapsed),
            still: state.starts_with('T') || state.starts_with('Z'),
            marked: false,
        })
    }

    /// `[[dd-]hh:]mm:ss`.
    fn elapsed_secs(text: &str) -> Option<u64> {
        let (days, clock) = match text.split_once('-') {
            Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
            None => (0, text),
        };
        let parts: Vec<u64> = clock
            .split(':')
            .map(|p| p.parse().ok())
            .collect::<Option<_>>()?;
        let secs = parts.iter().fold(0, |total, part| total * 60 + part);
        Some(days * 86_400 + secs)
    }

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }

    /// A group member that started while the command ran: a later group that reused the
    /// number started after it ended.
    pub(super) fn group_member(process: &Found, run: &Run) -> bool {
        process.started + 1 >= run.started_secs
            && run
                .ended_secs
                .is_none_or(|ended| process.started <= ended + 1)
    }

    /// The process found, with its start time; checked again right before each signal.
    pub(super) struct Handle {
        found: Found,
    }

    impl Handle {
        pub(super) fn of(found: &Found) -> Option<Self> {
            Some(Self {
                found: found.clone(),
            })
        }

        pub(super) fn found(&self) -> &Found {
            &self.found
        }

        /// Only if the pid still names the process found. Start times come in whole seconds,
        /// so a second either way is the same process.
        pub(super) fn signal(&self, sig: Signal) {
            let pid = self.found.pid.to_string();
            let still_it = ps(&["-p", &pid]).iter().any(|now| {
                now.pid == self.found.pid && now.started.abs_diff(self.found.started) <= 1
            });
            if still_it && let Some(pid) = Pid::from_raw(self.found.pid) {
                let _ = kill_process(pid, sig);
            }
        }
    }

    pub(super) fn adopt_orphans() {}

    pub(super) fn reap(_killed: impl Iterator<Item = i32>, _run: &Run, _me: i32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: i32, parent: i32, group: i32, started: u64) -> Found {
        Found {
            pid,
            parent,
            group,
            started,
            still: false,
            marked: false,
        }
    }

    fn run(reaped: bool) -> Run {
        Run {
            leader: 100,
            mark: "m".into(),
            reaped,
            started_secs: 1_000,
            ended_secs: reaped.then_some(1_010),
        }
    }

    #[test]
    fn a_reused_pid_is_not_the_process_that_was_recorded() {
        let recorded = process(200, 100, 100, 1_005);
        assert!(same(&recorded, &process(200, 100, 100, 1_005)));
        assert!(
            !same(&recorded, &process(200, 1, 7, 2_000)),
            "same pid, another process"
        );
    }

    #[test]
    fn a_reaped_leader_and_strangers_are_never_chosen() {
        let me = 50;
        let all = [
            process(100, me, 100, 1_000),  // the leader
            process(101, 100, 100, 1_001), // its child, in its group
            process(102, 101, 102, 1_002), // a grandchild in a session of its own
            process(300, 1, 300, 900),     // a stranger
            process(301, me, 301, 1_003),  // Spade's own child, unmarked
        ];
        let alive = select(&all, &run(false), me);
        assert_eq!(alive, [100, 101, 102].into_iter().collect());
        let reaped = select(&all, &run(true), me);
        assert!(!reaped.contains(&100), "never the reaped leader's number");
        assert!(!reaped.contains(&300) && !reaped.contains(&301));
    }

    #[test]
    fn a_process_sent_a_stop_but_seen_running_is_not_frozen() {
        let known = [process(101, 100, 100, 1_001), process(102, 101, 102, 1_002)];
        let mut stopped = process(101, 100, 100, 1_001);
        stopped.still = true;
        let running = process(102, 101, 102, 1_002);
        assert!(!all_still(&known, &[stopped.clone(), running]));
        // Gone, or its number now another process's: nothing of it is left to stop.
        let reused = process(102, 1, 900, 5_000);
        assert!(all_still(&known, &[stopped.clone(), reused]));
        assert!(all_still(&known, &[stopped]));
    }

    #[test]
    fn the_mark_alone_never_chooses_a_process() {
        let me = 50;
        let mut marked_stranger = process(400, 1, 400, 1_004);
        marked_stranger.marked = true;
        assert!(select(&[marked_stranger], &run(true), me).is_empty());
    }
}
