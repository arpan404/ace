//! Signals and reaping for a command in its own session, on every Linux ABI.
use super::children;
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions};
use std::process::Child;
use std::sync::{Arc, Mutex};

/// How the command ended, once everything it started is gone too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Code(u8),
    /// The signal that ended it. The launcher gives the caller back its terminal before it ends
    /// the same way.
    Signal(i32),
}

pub fn wait(child: Child, mut signals: signal_hook::iterator::Signals) -> Result<Ended, String> {
    let pid = Pid::from_child(&child);
    let fd = rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())
        .map_err(|e| e.to_string())?;
    let reaper = Arc::new(children::Reaper::new(pid).map_err(|e| e.to_string())?);
    let signals_reaper = Arc::clone(&reaper);
    let active = Arc::new(Mutex::new(true));
    let forwarding = Arc::clone(&active);
    std::thread::spawn(move || {
        for signal in signals.forever() {
            if signal == signal_hook::consts::SIGCHLD {
                signals_reaper.reap_orphans();
                continue;
            }
            let signal = match signal {
                signal_hook::consts::SIGINT => Signal::INT,
                signal_hook::consts::SIGQUIT => Signal::QUIT,
                signal_hook::consts::SIGTERM => Signal::TERM,
                signal_hook::consts::SIGHUP => Signal::HUP,
                _ => continue,
            };
            {
                let Ok(running) = forwarding.lock() else {
                    return;
                };
                if !*running {
                    continue;
                }
                // The leader is not reaped while this lock is held, so its group number
                // cannot be reused for a host group. Before setsid, address only the leader.
                if rustix::process::kill_process_group(pid, signal).is_err() {
                    let _ = rustix::process::pidfd_send_signal(&fd, signal);
                }
            }
            if matches!(signal, Signal::TERM | Signal::HUP) {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let _ = rustix::process::pidfd_send_signal(&fd, Signal::KILL);
                let _ = signals_reaper.kill();
            }
        }
    });
    loop {
        // WNOWAIT keeps the leader's identity reserved until forwarding has been disabled.
        match rustix::process::waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
        ) {
            Ok(Some(_)) => break,
            Ok(None) | Err(rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let status = {
        let mut running = active.lock().map_err(|_| "the signal lock failed")?;
        *running = false;
        reaper.root_status().map_err(|e| e.to_string())?
    };
    reaper
        .finish()
        .map_err(|e| format!("the command's descendants could not be stopped: {e}"))?;
    if let Some(code) = status.exit_status() {
        return Ok(Ended::Code(u8::try_from(code & 0xff).unwrap_or(1)));
    }
    if let Some(signal) = status.terminating_signal() {
        return Ok(Ended::Signal(signal));
    }
    Ok(Ended::Code(1))
}
