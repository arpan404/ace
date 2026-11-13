//! Ending everything a shell command started (ADR 0142), on macOS and Linux. Killing the
//! command's process group is not enough: a child can start its own session (`setsid`) and
//! leave the group, and once its parent exits it is reparented away from the command.
//!
//! So each command carries a mark in its environment (`SPADE_RUN=<random>`), which every process
//! it starts inherits, and its end goes in steps: every process descended from the command or
//! carrying its mark is stopped (`SIGSTOP`), so none can start another, until a look finds no
//! new one; then they are all killed, with the group. On Linux, Spade is also a child subreaper,
//! so an orphan becomes Spade's child rather than init's, and the killed ones are reaped.
//!
//! The limit, said plainly. On Linux, a process that clears its environment and starts another
//! program, and is reparented away before the command ends, can survive. On macOS the mark can't
//! be read (the system shows no other process's environment), so only the command's tree is
//! followed: a process that detached and was reparented away before the end (a daemon left by a
//! command that finished) can survive. One still in the tree when the command is stopped (its
//! deadline, a take-over, Stop) is ended wherever its session is.

use std::collections::BTreeSet;

use rustix::process::{Pid, Signal, kill_process, kill_process_group};

/// The variable each command carries, so whatever it starts can be found.
pub(super) const MARK: &str = "SPADE_RUN";

/// How many times the tree is looked at again while it is frozen.
const LOOKS: usize = 8;

/// Every process now: (pid, parent pid, environment holds `mark`).
fn processes(mark: &str) -> Vec<(i32, i32, bool)> {
    platform::processes(&format!("{MARK}={mark}"))
}

/// Processes descended from `leader` or carrying `mark`, `leader` included.
fn tree(leader: i32, mark: &str) -> BTreeSet<i32> {
    let all = processes(mark);
    let mut found: BTreeSet<i32> = all
        .iter()
        .filter(|(_, _, marked)| *marked)
        .map(|(pid, _, _)| *pid)
        .collect();
    found.insert(leader);
    // Children of anything found, until nothing new.
    loop {
        let more: Vec<i32> = all
            .iter()
            .filter(|(pid, parent, _)| found.contains(parent) && !found.contains(pid))
            .map(|(pid, _, _)| *pid)
            .collect();
        if more.is_empty() {
            break;
        }
        found.extend(more);
    }
    found.remove(&std::process::id().cast_signed());
    found.retain(|pid| *pid > 1);
    found
}

fn signal(pid: i32, sig: Signal) {
    if let Some(pid) = Pid::from_raw(pid) {
        let _ = kill_process(pid, sig);
    }
}

/// Ends the command led by `leader` and everything it started, however far it went.
pub(super) fn end(leader: u32, mark: &str) {
    let Ok(leader) = i32::try_from(leader) else {
        return;
    };
    let mut frozen: BTreeSet<i32> = BTreeSet::new();
    for _ in 0..LOOKS {
        let now = tree(leader, mark);
        let new: Vec<i32> = now.difference(&frozen).copied().collect();
        if new.is_empty() {
            break;
        }
        for pid in &new {
            signal(*pid, Signal::STOP);
        }
        frozen.extend(new);
    }
    if let Some(group) = Pid::from_raw(leader) {
        let _ = kill_process_group(group, Signal::KILL);
    }
    for pid in &frozen {
        signal(*pid, Signal::KILL);
    }
    platform::reap(&frozen, leader);
}

/// Makes Spade the child subreaper (Linux), so what a command leaves behind is reparented to
/// Spade and stays findable. Elsewhere nothing.
pub fn adopt_orphans() {
    platform::adopt_orphans();
}

#[cfg(target_os = "linux")]
mod platform {
    use std::collections::BTreeSet;

    use rustix::process::{Pid, WaitOptions, waitpid};

    /// From `/proc`: each process's parent (from `stat`, after the command name) and whether its
    /// environment (readable for Spade's own user) holds `marked`.
    pub(super) fn processes(marked: &str) -> Vec<(i32, i32, bool)> {
        let needle = marked.as_bytes();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<i32>().ok())
            else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let parent = stat
                .rsplit_once(')')
                .and_then(|(_, rest)| rest.split_whitespace().nth(1))
                .and_then(|p| p.parse::<i32>().ok())
                .unwrap_or(0);
            let marked = std::fs::read(entry.path().join("environ"))
                .is_ok_and(|env| env.split(|b| *b == 0).any(|var| var == needle));
            out.push((pid, parent, marked));
        }
        out
    }

    pub(super) fn adopt_orphans() {
        if let Err(error) = rustix::process::set_child_subreaper(Pid::from_raw(1)) {
            tracing::warn!(%error, "Spade could not become a child subreaper");
        }
    }

    /// Reaps killed processes that became Spade's children. The command's own leader is
    /// tokio's to reap, so it is left alone.
    pub(super) fn reap(killed: &BTreeSet<i32>, leader: i32) {
        for _ in 0..20 {
            let mut left = false;
            for pid in killed.iter().filter(|pid| **pid != leader) {
                let Some(pid) = Pid::from_raw(*pid) else {
                    continue;
                };
                match waitpid(Some(pid), WaitOptions::NOHANG) {
                    Ok(None) => left = true,
                    // Reaped, or not Spade's child.
                    Ok(Some(_)) | Err(_) => {}
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
    use std::collections::BTreeSet;

    /// From `ps`: pid and parent. The mark is never seen here (macOS shows no other process's
    /// environment), so only the tree is followed.
    pub(super) fn processes(_marked: &str) -> Vec<(i32, i32, bool)> {
        let Ok(output) = std::process::Command::new("/bin/ps")
            .args(["-ax", "-o", "pid=", "-o", "ppid="])
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse().ok()?;
                let parent = fields.next()?.parse().ok()?;
                Some((pid, parent, false))
            })
            .collect()
    }

    pub(super) fn adopt_orphans() {}

    pub(super) fn reap(_killed: &BTreeSet<i32>, _leader: i32) {}
}
