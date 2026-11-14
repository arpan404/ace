// SPDX-License-Identifier: Apache-2.0
//! Unix: Chrome in a process group of its own, with its debugging pipe on fds 3 and 4.
//!
//! - **Whole tree.** `kill_tree` signals the group, so Chrome's helpers go with it.
//! - **Parent death.** Chrome exits by itself when its pipe's read end reaches end of file,
//!   which happens when this process dies and the kernel closes the write end. On Linux the
//!   child also gets `PR_SET_PDEATHSIG`. That signal fires when the *thread* that forked dies,
//!   so the fork happens on a reaper thread that lives exactly as long as Chrome does.

use media_codec::CodecError;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc::channel;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub type Spawned = (Browser, Box<dyn Write + Send>, Box<dyn Read + Send>);

pub struct Browser {
    pid: u32,
    exited: Arc<(Mutex<bool>, Condvar)>,
}

fn backend(error: impl std::fmt::Display) -> CodecError {
    CodecError::Backend(error.to_string())
}

pub fn spawn(executable: &Path, args: Vec<String>) -> Result<Spawned, CodecError> {
    use command_fds::{CommandFdExt, FdMapping};
    let (chrome_reads, ours_writes) = std::io::pipe().map_err(backend)?;
    let (ours_reads, chrome_writes) = std::io::pipe().map_err(backend)?;
    let (chrome_reads, chrome_writes) = (OwnedFd::from(chrome_reads), OwnedFd::from(chrome_writes));
    let executable = executable.to_path_buf();
    let exited = Arc::new((Mutex::new(false), Condvar::new()));
    let reaper_exited = exited.clone();
    let (started, pid) = channel();
    std::thread::Builder::new()
        .name("media-chrome-reaper".into())
        .spawn(move || {
            let mut command = std::process::Command::new(&executable);
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            let mapped = command.fd_mappings(vec![
                FdMapping {
                    parent_fd: chrome_reads,
                    child_fd: 3,
                },
                FdMapping {
                    parent_fd: chrome_writes,
                    child_fd: 4,
                },
            ]);
            if let Err(error) = mapped {
                let _ = started.send(Err(backend(error)));
                return;
            }
            #[cfg(target_os = "linux")]
            set_parent_death_signal(&mut command);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    let _ = started.send(Err(CodecError::Backend(format!(
                        "Chrome failed to start: {error}"
                    ))));
                    return;
                }
            };
            // The child's pipe ends close here, so Chrome exiting reads as end of file.
            drop(command);
            let _ = started.send(Ok(child.id()));
            let _ = child.wait();
            let (lock, changed) = &*reaper_exited;
            if let Ok(mut done) = lock.lock() {
                *done = true;
            }
            changed.notify_all();
        })
        .map_err(backend)?;
    let pid = pid
        .recv()
        .map_err(|_| CodecError::Backend("Chrome's launcher thread ended".into()))??;
    Ok((
        Browser { pid, exited },
        Box::new(ours_writes),
        Box::new(ours_reads),
    ))
}

#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn set_parent_death_signal(command: &mut std::process::Command) {
    // SAFETY: the hook runs in the child between fork and exec. It only calls prctl(2), which
    // is async-signal-safe, and builds an io::Error from an errno without allocating.
    unsafe {
        command.pre_exec(|| {
            nix::sys::prctl::set_pdeathsig(Signal::SIGKILL).map_err(std::io::Error::from)
        });
    }
}

impl Browser {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn exited(&self) -> bool {
        self.exited.0.lock().is_ok_and(|done| *done)
    }

    /// True once Chrome has exited, waiting at most `timeout`.
    pub fn wait(&self, timeout: Duration) -> bool {
        let (lock, changed) = &*self.exited;
        let Ok(done) = lock.lock() else {
            return false;
        };
        changed
            .wait_timeout_while(done, timeout, |done| !*done)
            .is_ok_and(|(done, _)| *done)
    }

    /// SIGKILL to Chrome's whole process group: the browser and every helper it started.
    pub fn kill_tree(&self) {
        if let Ok(pid) = i32::try_from(self.pid) {
            let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
        }
    }
}

/// The process exists (a signal could be sent to it, or it belongs to someone else).
pub fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    match nix::sys::signal::kill(Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(error) => error == nix::errno::Errno::EPERM,
    }
}
