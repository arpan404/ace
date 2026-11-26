// SPDX-License-Identifier: Apache-2.0
//! A child command whose answer is bounded in time and bytes, as the TypeScript's
//! `execFile` and `spawnSync` calls are: `peer-process.ts:77`–`:86` asks `lsof` about
//! one process with a 2 s timeout and a 1 MB buffer, and `home-openers.ts:110`–`:120`
//! asks it about a home's files with 5 s. A host whose `lsof` hangs must not hold a
//! stop request or a fresh start open, and a busy host's listing must not be held in
//! memory whole.
//!
//! TypeScript cases ported: `peer-process.test.ts` and `home-openers.test.ts`'s
//! lsof cases (a listing that never answers is nobody).

use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a command may take, and how much of its stdout is kept.
#[derive(Debug, Clone, Copy)]
pub struct Bounds {
    pub timeout: Duration,
    pub max_bytes: usize,
}

/// The 2 s `/usr/sbin/lsof` ask for one process's sockets (`peer-process.ts`).
pub const LSOF_PROCESS: Bounds = Bounds {
    timeout: Duration::from_secs(2),
    max_bytes: 1_048_576,
};

/// The 5 s `lsof -t` ask for the processes holding a home's files (`home-openers.ts`).
pub const LSOF_OPENERS: Bounds = Bounds {
    timeout: Duration::from_secs(5),
    max_bytes: 1_048_576,
};

/// Runs `command` and returns its stdout, or `None` when it could not be spawned.
///
/// Output past `max_bytes` is cut there, and a child still running at the deadline is
/// killed: a partial answer is returned, as `execFile`'s callback sees partial stdout
/// with its timeout error.
pub fn stdout(command: &Path, args: &[OsString], bounds: Bounds) -> Option<Vec<u8>> {
    let mut command = Command::new(command);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Its own process group, so a child it started (a shell's grandchild) cannot keep
    // the pipe open past the deadline.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let max = bounds.max_bytes;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut bounded = stdout.take(max as u64 + 1);
        let _ = bounded.read_to_end(&mut bytes);
        bytes.truncate(max);
        bytes
    });
    let deadline = Instant::now() + bounds.timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            stop(&mut child);
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Some(reader.join().unwrap_or_default())
}

/// Ends the child and everything it started, then reaps it.
fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        use rustix::process::{Pid, Signal, kill_process_group};
        if let Ok(pid) = i32::try_from(child.id()).map(Pid::from_raw)
            && let Some(pid) = pid
        {
            let _ = kill_process_group(pid, Signal::KILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::{Bounds, stdout};
    use std::ffi::OsString;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn shell(script: &str) -> Vec<OsString> {
        vec!["-c".into(), script.into()]
    }

    /// A command that finishes gives what it wrote.
    #[test]
    fn a_finished_command_gives_its_stdout() {
        let bytes = stdout(
            Path::new("/bin/sh"),
            &shell("printf 'hello'"),
            Bounds {
                timeout: Duration::from_secs(2),
                max_bytes: 1024,
            },
        );
        assert_eq!(bytes.as_deref(), Some(&b"hello"[..]));
    }

    /// A command that never finishes is killed at its deadline, and its partial answer
    /// is returned rather than none (`execFile`'s timeout with stdout).
    #[test]
    fn a_command_outliving_its_deadline_is_stopped_with_what_it_wrote() {
        let began = Instant::now();
        let bytes = stdout(
            Path::new("/bin/sh"),
            &shell("printf x; sleep 30"),
            Bounds {
                timeout: Duration::from_millis(300),
                max_bytes: 1024,
            },
        );
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "the deadline bounds the call, took {:?}",
            began.elapsed()
        );
        assert_eq!(bytes.as_deref(), Some(&b"x"[..]));
    }

    /// Output past the cap is cut there, even when the child keeps writing.
    #[test]
    fn output_past_the_cap_is_cut() {
        let bytes = stdout(
            Path::new("/bin/sh"),
            &shell("while :; do printf x; done"),
            Bounds {
                timeout: Duration::from_millis(300),
                max_bytes: 1000,
            },
        );
        assert_eq!(bytes.map(|bytes| bytes.len()), Some(1000));
    }

    /// A command that cannot be started answers nothing.
    #[test]
    fn a_missing_command_answers_nothing() {
        assert_eq!(
            stdout(
                Path::new("/nonexistent/lsof"),
                &[],
                Bounds {
                    timeout: Duration::from_secs(1),
                    max_bytes: 16
                }
            ),
            None
        );
    }
}
