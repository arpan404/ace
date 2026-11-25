// SPDX-License-Identifier: Apache-2.0
//! Ending a Git call's process tree and naming why a spawn failed (G2a):
//! group teardown, the Windows `taskkill` route, exit draining and the error
//! classification `classifySpawn` gives a failed start.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ace_supervisor::signal::SignalName;
use tokio::sync::Notify;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::events::ProcessEvent;
use crate::core::ports::{ProcessPorts, TimeoutScheduler, sleep_with};
use crate::core::spawn::{ProcessChild, SpawnRequest};

pub(crate) fn parse_signal(signal: &str) -> SignalName {
    match signal {
        "SIGTERM" => SignalName::Term,
        _ => SignalName::Kill,
    }
}

/// Wait until the process group led by `child` has no live members, bounded by `ms` (default 3s).
pub async fn group_gone(ports: &ProcessPorts, child: &dyn ProcessChild, ms: u64) {
    let Some(pid) = child.pid() else {
        return;
    };
    if ports.platform == "win32" {
        return;
    }
    const STEP: u64 = 15;
    let mut waited = 0u64;
    while waited < ms {
        if !ports.group_alive(child, pid).await {
            return;
        }
        sleep_with(ports.scheduler.as_ref(), STEP).await;
        waited += STEP;
    }
}

/// Kill the process tree led by `child` using the `platform` port strategy (`process-runtime.ts`).
pub async fn kill_tree(ports: &ProcessPorts, child: Arc<dyn ProcessChild>) {
    if child.exited() {
        if let Some(pid) = child.pid()
            && ports.platform != "win32"
            && ports.group_alive(child.as_ref(), pid).await
        {
            let _ = ports.signal_group(child.as_ref(), pid, "SIGKILL").await;
        }
        return;
    }
    if let Some(pid) = child.pid()
        && ports.platform == "win32"
    {
        // taskkill is spawned with the daemon's whole environment and, on a
        // Windows host, from System32: exactly what TS passes (it leaves `env`
        // to node's inheritance and reads `process.env.SystemRoot`).
        let environment = (ports.environment)();
        let cwd = if cfg!(windows) {
            let root = environment
                .iter()
                .rev()
                .find(|(key, _)| key.eq_ignore_ascii_case("SystemRoot"))
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| "C:\\Windows".to_owned());
            Some(format!("{root}\\System32"))
        } else {
            None
        };
        let spawned = ports
            .spawner
            .spawn(SpawnRequest {
                command: "taskkill".to_owned(),
                args: vec![
                    "/PID".to_owned(),
                    pid.to_string(),
                    "/T".to_owned(),
                    "/F".to_owned(),
                ],
                cwd,
                env: environment,
                detached: false,
                hide_window: true,
            })
            .await;
        spawned.child.end_stdin();
        let killer = spawned.child;
        let events = spawned.events;
        let timed_out = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        let killer_for_timer = Arc::clone(&killer);
        let child_for_timer = Arc::clone(&child);
        let t_flag = Arc::clone(&timed_out);
        let t_notify = Arc::clone(&notify);
        let cancel = ports.scheduler.schedule(
            10_000,
            Box::new(move || {
                t_flag.store(true, Ordering::Release);
                killer_for_timer.kill_leader("SIGKILL");
                child_for_timer.kill_leader("SIGKILL");
                killer_for_timer.destroy();
                t_notify.notify_waiters();
            }),
        );
        loop {
            let expired = notify.notified();
            tokio::pin!(expired);
            expired.as_mut().enable();
            if timed_out.load(Ordering::Acquire) {
                break;
            }
            tokio::select! {
                biased;
                _ = &mut expired => break,
                ev = events.recv() => match ev {
                    Some(ProcessEvent::SpawnError { .. }) => {
                        cancel.cancel();
                        child.kill_leader("SIGKILL");
                        killer.destroy();
                        break;
                    }
                    Some(ProcessEvent::Close { code, .. }) => {
                        cancel.cancel();
                        if code != Some(0) {
                            child.kill_leader("SIGKILL");
                        }
                        break;
                    }
                    None => {
                        cancel.cancel();
                        break;
                    }
                    _ => {}
                }
            }
        }
        return;
    }
    if let Some(pid) = child.pid() {
        if ports
            .signal_group(child.as_ref(), pid, "SIGKILL")
            .await
            .is_err()
        {
            child.kill_leader("SIGKILL");
        }
    } else {
        child.kill_leader("SIGKILL");
    }
}

/// Drain the leader's exit bounded by 1000 ms (`drainProcessExit` in `process-runtime.ts`).
pub async fn drain_process_exit(scheduler: &dyn TimeoutScheduler, child: &dyn ProcessChild) {
    if child.pid().is_none() || child.exited() {
        return;
    }
    let exit_notify = child.exit_notify();
    let done = Arc::new(AtomicBool::new(false));
    let timer_notify = Arc::new(Notify::new());
    let d = Arc::clone(&done);
    let n = Arc::clone(&timer_notify);
    let cancel = scheduler.schedule(
        1_000,
        Box::new(move || {
            d.store(true, Ordering::Release);
            n.notify_waiters();
        }),
    );
    loop {
        let exited = exit_notify.notified();
        tokio::pin!(exited);
        exited.as_mut().enable();
        let expired = timer_notify.notified();
        tokio::pin!(expired);
        expired.as_mut().enable();
        if child.exited() || done.load(Ordering::Acquire) {
            break;
        }
        tokio::select! {
            biased;
            _ = &mut exited => {}
            _ = &mut expired => {}
        }
    }
    cancel.cancel();
}

/// Classify a spawn error into `not_a_repo`, `git_missing`, or `git_failed` (`classifySpawn`).
pub fn classify_spawn_error(
    code: Option<&str>,
    message: &str,
    cwd: &str,
    binary: &str,
) -> GitError {
    if code == Some("ENOENT") && std::fs::metadata(cwd).is_err() {
        return GitError::new(
            GitErrorCode::NotARepo,
            format!("Git working directory no longer exists: {cwd}"),
        );
    }
    if code == Some("ENOENT") {
        GitError::new(
            GitErrorCode::GitMissing,
            format!("Git binary not found: {binary}"),
        )
        .with_detail("binary", ace_json::Value::from(binary))
    } else {
        GitError::new(GitErrorCode::GitFailed, message)
            .with_detail("binary", ace_json::Value::from(binary))
    }
}
