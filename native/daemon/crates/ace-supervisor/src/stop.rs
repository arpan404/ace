// SPDX-License-Identifier: Apache-2.0
//! What a stop reaches: POSIX group signals, retained stops that outlive
//! their leader, and the Windows whole-tree stop. Ports `process-owner.ts`
//! (the signal half) and `tree-stop.ts`. The guard over who may be
//! signalled stays on the shell boundary; everything here is unguarded.

use crate::errors::SupervisorError;
use crate::signal::SignalName;
use crate::wintree::{WindowsRecord, WindowsTerminate, WindowsTreeState};

/// What a stop may do to a tree, injected for tests.
pub trait StopTree {
    /// Ends the tree politely (SIGTERM, graceful taskkill).
    fn terminate(&self, pid: u32);
    /// Ends the tree forcefully (SIGKILL, forced taskkill).
    fn destroy(&self, pid: u32);
}

/// Where a retained stop reports the tree gone.
pub trait StopEvents {
    /// The tree is confirmed gone; stops waiting on it resolve.
    fn tree_gone(&self);
    /// The forced stop did not end the tree; it stays owned meanwhile.
    fn stop_failed(&self, message: String);
}

/// A retained stop: polite, then forceful after the grace, confirmed gone.
/// A later stop with a shorter grace moves the force earlier, never later.
/// On Windows a surviving tree is rechecked with backoff until it is gone.
pub async fn run_retained_stop<T, E>(
    tree: T,
    pid: u32,
    windows: bool,
    confirm_gone: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    mut requests: tokio::sync::mpsc::UnboundedReceiver<crate::spawn::StopRequest>,
    events: E,
) where
    T: StopTree + Sync + Send + 'static,
    E: StopEvents + Sync + Send + 'static,
{
    use tokio::time::{Duration, Instant, sleep};
    let mut deadline: Option<Instant> = None;
    let mut terminated = false;
    let mut failed = false;
    let mut backoff_ms = 1_000u64;
    loop {
        if !terminated {
            let Some(request) = requests.recv().await else {
                return;
            };
            deadline = Some(Instant::now() + Duration::from_millis(request.grace_ms));
            tree.terminate(pid);
            terminated = true;
        }
        let end = deadline.unwrap_or_else(Instant::now);
        if failed {
            // Survivors stay owned until confirmed gone; the recheck backs off.
            tokio::select! {
                request = requests.recv() => {
                    let Some(request) = request else { return };
                    tree.destroy(pid);
                    let _ = request;
                }
                _ = sleep(Duration::from_millis(backoff_ms)) => {
                    backoff_ms = (backoff_ms * 2).min(60_000);
                    if confirm_gone() {
                        events.tree_gone();
                        return;
                    }
                }
            }
            continue;
        }
        tokio::select! {
            request = requests.recv() => {
                let Some(request) = request else { return };
                let earlier = Instant::now() + Duration::from_millis(request.grace_ms);
                if earlier < end {
                    deadline = Some(earlier);
                }
            }
            _ = sleep(Duration::from_millis(25)) => {
                if confirm_gone() {
                    events.tree_gone();
                    return;
                }
                if Instant::now() >= end {
                    tree.destroy(pid);
                    if confirm_gone() || !windows {
                        events.tree_gone();
                        return;
                    }
                    failed = true;
                    events.stop_failed("Windows process tree survived its forced stop".to_owned());
                }
            }
        }
    }
}

/// Ends a group with `signal`. ESRCH proves it gone; on darwin EPERM while
/// a group exits is not a failure either.
#[cfg(unix)]
pub fn kill_group(group: u32, signal: SignalName) -> Result<(), SupervisorError> {
    let raw = i32::try_from(group)
        .ok()
        .filter(|raw| *raw > 0)
        .ok_or_else(|| SupervisorError::InvalidInput(format!("bad group {group}")))?;
    let Some(target) = rustix::process::Pid::from_raw(raw) else {
        return Err(SupervisorError::InvalidInput(format!("bad group {group}")));
    };
    let sig = match signal {
        SignalName::Term => rustix::process::Signal::TERM,
        SignalName::Kill => rustix::process::Signal::KILL,
    };
    match rustix::process::kill_process_group(target, sig) {
        Ok(()) => Ok(()),
        Err(error) if error == rustix::io::Errno::SRCH => Ok(()),
        #[cfg(target_os = "macos")]
        Err(error) if error == rustix::io::Errno::PERM => Ok(()),
        Err(error) => Err(SupervisorError::Operation(format!(
            "signal of group {group} failed: {error}"
        ))),
    }
}

/// No process groups exist on Windows; stop the whole tree instead.
#[cfg(windows)]
pub fn kill_group(_group: u32, _signal: SignalName) -> Result<(), SupervisorError> {
    Err(SupervisorError::Unavailable(
        "process groups do not exist on Windows".to_owned(),
    ))
}

/// A graceful stop that escalates after the grace, like the shell's retained
/// path. Resolves only once the group is proven gone.
#[cfg(unix)]
pub fn stop_retained_group(group: u32, grace_ms: u64) -> Result<(), SupervisorError> {
    kill_group(group, SignalName::Term)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(grace_ms);
    loop {
        match crate::reaper::process_group_alive(group) {
            Ok(false) => return Ok(()),
            Ok(true) => {}
            // The kernel refused the probe while the group exits: keep waiting.
            Err(SupervisorError::Unavailable(_)) => {}
            Err(error) => return Err(error),
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    kill_group(group, SignalName::Kill)?;
    Ok(())
}

/// A process's creation time and owner for the tree stop.
pub trait TreeStopIdentify {
    /// Creation time and owner of a live pid; `None` once it is gone.
    fn identify(&self, pid: u32) -> Option<(String, String)>;
}

/// The recorded-tree runtime behind the Windows stop.
pub trait TreeStopTree {
    /// The recorded members' state now.
    fn state(&self, recorded: &[WindowsRecord]) -> WindowsTreeState;
    /// Ends one member; returns what it did.
    fn terminate(&self, member: &WindowsRecord) -> Result<WindowsTerminate, SupervisorError>;
}

/// How long recorded survivors may take to die before the stop fails them.
pub const SURVIVOR_STOP_MS: u64 = 5_000;

/// Proven members of the tree, grown as live members start children.
pub type RecordedTree = Vec<WindowsRecord>;

/// Records `pid`'s tree now, while its leader still names its descendants.
/// `None` when nothing can be proven ours; the tree stop stays in charge.
pub fn record_tree<T: TreeStopIdentify + TreeStopTree>(
    pid: u32,
    runtime: &T,
) -> Option<RecordedTree> {
    let (start, uid) = runtime
        .identify(pid)
        .unwrap_or_else(|| ("".to_owned(), "".to_owned()));
    if start.is_empty() {
        return None;
    }
    let recorded = vec![WindowsRecord { pid, start, uid }];
    Some(runtime.state(&recorded).live)
}

/// Members still alive, plus children they were proven to start since.
pub fn tree_survivors<T: TreeStopTree>(
    recorded: &mut RecordedTree,
    runtime: &T,
) -> Result<Vec<WindowsRecord>, SupervisorError> {
    let state = runtime.state(recorded);
    recorded.extend(state.discovered.iter().cloned());
    Ok(state.live)
}

/// Ends every recorded member still alive; resolves once none is left.
pub fn end_recorded_tree<T: TreeStopTree>(
    recorded: &mut RecordedTree,
    runtime: &T,
    deadline: std::time::Instant,
) -> Result<(), SupervisorError> {
    loop {
        let left = tree_survivors(recorded, runtime)?;
        if left.is_empty() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(SupervisorError::Operation(
                "Windows process tree survived its stop".to_owned(),
            ));
        }
        for member in &left {
            runtime.terminate(member)?;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survivor_stop_bound_is_five_seconds() {
        assert_eq!(SURVIVOR_STOP_MS, 5_000);
    }
}
