// SPDX-License-Identifier: Apache-2.0
//! After the leader's exit: holding it until its group is confirmed empty
//! (then the reap), and, on Windows, telling the outputs when every pipe
//! writer is gone.

#[cfg(windows)]
use super::ChildJob;
#[cfg(unix)]
use crate::leader::Leader;
use std::sync::Arc;

/// Windows: once the job holds no process, every pipe writer is gone, so a
/// paused output may drain what is buffered and reach EOF.
#[cfg(windows)]
pub(super) async fn watch_writers(job: Arc<ChildJob>, budget: Arc<crate::pump::OutputBudget>) {
    use crate::contain::{JobRunning, WindowsJob as _};
    loop {
        let running = job
            .lock()
            .map(|mut job| job.running())
            .unwrap_or(JobRunning::Unjoined);
        match running {
            JobRunning::Running(true) => {}
            JobRunning::Running(false) => {
                budget.mark_writers_gone();
                return;
            }
            JobRunning::Unjoined => return,
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// The longest wait between scans while a group outlives its leader: short
/// at first, then rarer for a group that keeps living (a retained server).
#[cfg(unix)]
const SCAN_EARLY_MAX: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(unix)]
const SCAN_LATE_MAX: std::time::Duration = std::time::Duration::from_secs(60);
#[cfg(unix)]
const SCAN_EARLY_FOR: std::time::Duration = std::time::Duration::from_secs(600);
/// How long after the shell gave the group up a still-occupied group is
/// left before it is killed by number (still held, so safe).
#[cfg(unix)]
const HOLD_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Holds the exited leader until its group is confirmed empty, then reaps
/// it. Holding the leader here keeps it (and its registry entry) alive until
/// the reap, whoever else drops it. Scans at once, then at growing intervals;
/// a stop polling for the group, or the shell giving it up, wakes it.
#[cfg(unix)]
pub(super) async fn release_when_group_empty(leader: Arc<Leader>) {
    use crate::leader::ReleaseStep;
    let exited = tokio::time::Instant::now();
    let mut disowned_at: Option<tokio::time::Instant> = None;
    let mut delay = std::time::Duration::from_millis(1);
    loop {
        if disowned_at.is_none() && leader.disowned() {
            disowned_at = Some(tokio::time::Instant::now());
        }
        let limit_reached = disowned_at.is_some_and(|at| at.elapsed() >= HOLD_LIMIT);
        let probe = Arc::clone(&leader);
        match tokio::task::spawn_blocking(move || probe.step(limit_reached)).await {
            Ok(ReleaseStep::Done) => return,
            Ok(ReleaseStep::Held | ReleaseStep::Reaping) | Err(_) => {}
        }
        let most = if exited.elapsed() < SCAN_EARLY_FOR {
            SCAN_EARLY_MAX
        } else {
            SCAN_LATE_MAX
        };
        tokio::select! {
            () = tokio::time::sleep(delay) => {
                delay = (delay * 2).min(most);
            }
            () = leader.wake.notified() => {
                delay = std::time::Duration::from_millis(1);
            }
        }
    }
}
