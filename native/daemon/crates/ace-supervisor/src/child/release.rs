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
/// paused output may drain what is buffered and reach EOF. A job the shell
/// already closed reads as unjoined: closing a kill-on-close job ended every
/// member (contained children always join), so the writers are gone then
/// too, and the drain still runs rather than the watch giving up.
#[cfg(windows)]
pub(super) async fn watch_writers(job: Arc<ChildJob>, budget: Arc<crate::pump::OutputBudget>) {
    use crate::contain::{JobRunning, WindowsJob as _};
    loop {
        let running = job
            .lock()
            .map(|mut job| job.running())
            .unwrap_or(JobRunning::Unreadable);
        match running {
            // Only a confirmed zero count or a closed job means gone.
            JobRunning::Running(false) | JobRunning::Closed => {
                budget.mark_writers_gone();
                return;
            }
            // Members left, or unknown: keep waiting.
            JobRunning::Running(true) | JobRunning::Unjoined | JobRunning::Unreadable => {}
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
/// The least time between scans of a group reported stuck, however often
/// stops wake the loop.
#[cfg(unix)]
const STUCK_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(1);
/// How long after the shell gave the group up a still-occupied group is
/// left before the escalation: a kill through the shell's guard (spared
/// members keep the group held), again each period after.
#[cfg(unix)]
const HOLD_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// What the release loop does when a given-up group outlives the hold
/// limit: `limit` asks for the guarded kill; `stuck` reports, once, a group
/// still held a whole period after the first kill (a member that does not
/// exit, such as one in uninterruptible sleep, or a scan that cannot read
/// `/proc`). Such a group then stays held, scanned at the low rate, until it
/// empties or the daemon exits; its number is still only ever signalled
/// while held.
#[cfg(unix)]
pub(super) struct Escalation {
    pub(super) limit: Box<dyn Fn() + Send + Sync>,
    pub(super) stuck: Box<dyn Fn() + Send + Sync>,
}

/// Holds the exited leader until its group is confirmed empty, then reaps
/// it. Holding the leader here keeps it (and its registry entry) alive until
/// the reap, whoever else drops it. Scans at once, then at growing intervals;
/// a stop polling for the group, or the shell giving it up, wakes it.
#[cfg(unix)]
pub(super) async fn release_when_group_empty(leader: Arc<Leader>, escalation: Escalation) {
    use crate::leader::ReleaseStep;
    let exited = tokio::time::Instant::now();
    let mut disowned_at: Option<tokio::time::Instant> = None;
    let mut kills = 0u32;
    let mut delay = std::time::Duration::from_millis(1);
    loop {
        if disowned_at.is_none() && leader.disowned() {
            disowned_at = Some(tokio::time::Instant::now());
        }
        let probe = Arc::clone(&leader);
        match tokio::task::spawn_blocking(move || probe.step()).await {
            Ok(ReleaseStep::Done) => return,
            Ok(ReleaseStep::Held | ReleaseStep::Reaping) | Err(_) => {}
        }
        if let Some(at) = disowned_at
            && at.elapsed() >= HOLD_LIMIT * (kills + 1)
        {
            (escalation.limit)();
            kills += 1;
            if kills == 2 {
                (escalation.stuck)();
            }
        }
        if kills >= 2 {
            // Reported stuck: idle rescans once a minute; a real wake (a
            // stop polling for the group) scans sooner, but never more than
            // once per `STUCK_MIN_GAP`, so a flood of wakes cannot spin.
            let scanned = tokio::time::Instant::now();
            tokio::select! {
                () = tokio::time::sleep(SCAN_LATE_MAX) => {}
                () = leader.wake.notified() => {}
            }
            let since = scanned.elapsed();
            if since < STUCK_MIN_GAP {
                tokio::time::sleep(STUCK_MIN_GAP - since).await;
            }
            continue;
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
