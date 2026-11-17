//! Signals and reaping for a command in its own session, on every Linux ABI.
use super::children;
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, WaitOptions};
use std::fs::File;
use std::io::Write;
use std::process::{Child, ExitCode};
use std::sync::{Arc, Mutex};

pub fn wait(
    child: Child,
    mut ending: Option<File>,
    mut signals: signal_hook::iterator::Signals,
) -> Result<ExitCode, String> {
    let pid = Pid::from_child(&child);
    let fd = rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())
        .map_err(|e| e.to_string())?;
    let active = Arc::new(Mutex::new(true));
    let forwarding = Arc::clone(&active);
    std::thread::spawn(move || {
        for signal in signals.forever() {
            if signal == signal_hook::consts::SIGCHLD {
                children::reap_orphans(pid);
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
                let _ = children::kill();
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
        rustix::process::waitpid(Some(pid), WaitOptions::empty())
            .map_err(|e| e.to_string())?
            .ok_or("the command's status was missing")?
            .1
    };
    children::finish()
        .map_err(|e| format!("the command's descendants could not be stopped: {e}"))?;
    if let Some(code) = status.exit_status() {
        return Ok(ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1)));
    }
    if let Some(signal) = status.terminating_signal() {
        if let Some(file) = ending.as_mut() {
            // Namespace init cannot restore its own default fatal signal; the outer launcher can.
            writeln!(file, "{signal}").map_err(|e| e.to_string())?;
        } else {
            let _ = signal_hook::low_level::emulate_default_handler(signal);
        }
        return Ok(ExitCode::from(u8::try_from(128 + signal).unwrap_or(1)));
    }
    Ok(ExitCode::from(1))
}
