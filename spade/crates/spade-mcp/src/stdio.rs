//! The stdio transport (ADR 0151, point 11): an MCP server Spade starts as a child process and
//! speaks to over its stdin and stdout, beside the streamable HTTP one. The protocol code is the
//! same; only how a session opens and ends differs.
//!
//! The child gets exactly the environment it is given (nothing of Spade's), its own folder, and
//! no stderr. On macOS and Linux it leads its own process group, which is killed whole; on
//! Windows it is held in a job object that kills everything in it when closed. Either happens
//! when the session ends, is dropped, or goes unused for the idle time.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::Instant;

/// How long a server may go unused before it is stopped.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Restarts after a crash allowed within [`RESTART_WINDOW`]; past that it stays failed.
pub const MOST_RESTARTS: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

/// What a server that stopped too often says until it is turned off and on.
pub const FAILED: &str = "the server stopped 3 times in 10 minutes and is not started again until \
it is turned off and on";

/// A local server: the program, its arguments, the whole environment it runs with, and the
/// folder it runs in.
#[derive(Clone)]
pub struct StdioCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    /// Stopped after this long unused ([`IDLE`] unless a test shortens it).
    pub idle: Duration,
    /// Crash restarts allowed in [`StdioCommand::restart_window`].
    pub most_restarts: usize,
    pub restart_window: Duration,
}

impl StdioCommand {
    pub fn new(program: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: cwd.into(),
            idle: IDLE,
            most_restarts: MOST_RESTARTS,
            restart_window: RESTART_WINDOW,
        }
    }
}

/// The environment's values are left out: they can hold a plugin's tokens.
impl std::fmt::Debug for StdioCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("StdioCommand")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &names)
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

/// Crash restarts in a sliding window: pure, with the time passed in.
#[derive(Debug, Clone)]
pub struct RestartBudget {
    most: usize,
    window: Duration,
    starts: VecDeque<Instant>,
    spent: bool,
}

impl RestartBudget {
    pub fn new(most: usize, window: Duration) -> Self {
        Self {
            most,
            window,
            starts: VecDeque::new(),
            spent: false,
        }
    }

    /// Whether a restart at `now` is allowed. Once refused it stays refused.
    pub fn restart(&mut self, now: Instant) -> bool {
        if self.spent {
            return false;
        }
        while self
            .starts
            .front()
            .is_some_and(|start| now.duration_since(*start) >= self.window)
        {
            self.starts.pop_front();
        }
        if self.starts.len() >= self.most {
            self.spent = true;
            return false;
        }
        self.starts.push_back(now);
        true
    }

    pub fn spent(&self) -> bool {
        self.spent
    }
}

/// A running server process, killed with everything it started when this is dropped.
pub(crate) struct Process {
    child: Child,
    contained: platform::Contained,
}

impl Process {
    /// Starts `command` with its stdin and stdout piped.
    pub(crate) fn spawn(
        command: &StdioCommand,
    ) -> std::io::Result<(Self, ChildStdout, ChildStdin)> {
        let mut process = Command::new(&command.program);
        process
            .args(&command.args)
            .env_clear()
            .envs(command.env.iter().map(|(k, v)| (k, v)))
            .current_dir(&command.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        platform::prepare(&mut process);
        let mut child = process.spawn()?;
        let contained = platform::contain(&child);
        let stdout = child.stdout.take().ok_or_else(missing)?;
        let stdin = child.stdin.take().ok_or_else(missing)?;
        Ok((Self { child, contained }, stdout, stdin))
    }

    pub(crate) fn id(&self) -> Option<u32> {
        self.child.id()
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.contained.kill();
        let _ = self.child.start_kill();
    }
}

fn missing() -> std::io::Error {
    std::io::Error::other("the server's pipes were not opened")
}

#[cfg(unix)]
mod platform {
    use tokio::process::{Child, Command};

    pub(super) fn prepare(command: &mut Command) {
        command.process_group(0);
    }

    /// The group the server leads.
    pub(super) struct Contained(Option<i32>);

    pub(super) fn contain(child: &Child) -> Contained {
        Contained(child.id().and_then(|pid| i32::try_from(pid).ok()))
    }

    impl Contained {
        pub(super) fn kill(&mut self) {
            if let Some(group) = self.0.take()
                && let Some(pid) = rustix::process::Pid::from_raw(group)
            {
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use tokio::process::{Child, Command};
    use win32job::{ExtendedLimitInfo, Job};

    /// A new process group, so a console Ctrl-C to Spade does not reach it.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub(super) fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    /// The job object holding the server and everything it starts; closing it ends them all.
    pub(super) struct Contained(Option<Job>);

    pub(super) fn contain(child: &Child) -> Contained {
        let job = Job::create().ok().and_then(|job| {
            let mut info = ExtendedLimitInfo::new();
            info.limit_kill_on_job_close();
            job.set_extended_limit_info(&info).ok()?;
            let handle = child.raw_handle()?;
            job.assign_process(handle as isize).ok()?;
            Some(job)
        });
        Contained(job)
    }

    impl Contained {
        pub(super) fn kill(&mut self) {
            self.0 = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fourth_crash_inside_the_window_stays_failed_but_old_crashes_age_out() {
        let start = Instant::now();
        let window = Duration::from_secs(600);
        let mut budget = RestartBudget::new(3, window);
        for minute in 0..3 {
            assert!(budget.restart(start + Duration::from_secs(minute * 60)));
        }
        let mut aged = budget.clone();
        assert!(!budget.restart(start + Duration::from_secs(240)));
        assert!(budget.spent());
        // Refused once, it never restarts again, however long it waits.
        assert!(!budget.restart(start + Duration::from_secs(6000)));
        // The same three crashes, then one after the first has left the window.
        assert!(aged.restart(start + Duration::from_secs(601)));
    }
}
