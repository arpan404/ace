// SPDX-License-Identifier: Apache-2.0
//! What a supervised spawn is: the command, its exact environment, how its
//! standard streams attach, and the events it reports to the shell. Ports
//! the spawn options of `process.ts`, `process-bytes.ts` and
//! `process-interactive.ts`; the running child lives in `child.rs`.

use crate::errors::{NodeIoError, SupervisorError};
use crate::pump::Flow;
use std::sync::Arc;

/// How a standard stream is attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioMode {
    /// Piped and pumped as byte events.
    Piped,
    /// `/dev/null`.
    Ignore,
    /// The daemon's own stream (interactive children).
    Inherit,
    /// The daemon's standard error (a login writing to stderr).
    ToStderr,
}

/// What to spawn. `env` is the child's whole environment, as node's spawn
/// takes it: nothing of the daemon's own environment is inherited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    /// Windows: the arguments are a pre-quoted `cmd.exe` line.
    pub windows_verbatim: bool,
    /// Windows: no console window, like `windowsHide`.
    pub hide_window: bool,
    /// Windows: the child joins a kill-on-close job before it runs.
    pub contain: bool,
    /// The process's output budget (`maxOutputBytes`), stdout and stderr
    /// together: what pumps read ahead of the shell never exceeds it.
    pub max_output_bytes: Option<u64>,
    pub stdin: StdioMode,
    pub stdout: StdioMode,
    pub stderr: StdioMode,
}

impl SpawnSpec {
    /// Validates what the kernel would refuse: an empty command.
    pub fn validate(&self) -> Result<(), SupervisorError> {
        if self.command.is_empty() {
            return Err(SupervisorError::InvalidInput("empty command".to_owned()));
        }
        Ok(())
    }

    /// The command as the OS spawns it, with its three standard streams.
    /// POSIX children start a session of their own (`detached: true`), so
    /// they lead their own process group; Windows children start suspended
    /// when contained, so they are in their job before they run.
    pub(crate) fn command(
        &self,
        stdin: std::process::Stdio,
        stdout: std::process::Stdio,
        stderr: std::process::Stdio,
    ) -> std::process::Command {
        let mut command = std::process::Command::new(&self.command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            if self.windows_verbatim {
                for arg in &self.args {
                    command.raw_arg(arg);
                }
            } else {
                command.args(&self.args);
            }
            let mut flags = 0;
            if self.hide_window {
                flags |= CREATE_NO_WINDOW;
            }
            if self.contain {
                flags |= CREATE_SUSPENDED;
            }
            command.creation_flags(flags);
        }
        #[cfg(not(windows))]
        command.args(&self.args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            // SAFETY: the hook runs in the forked child before exec and only
            // calls setsid(2), which is async-signal-safe and allocates nothing.
            #[allow(unsafe_code)]
            unsafe {
                command.pre_exec(|| {
                    rustix::process::setsid()
                        .map(|_| ())
                        .map_err(std::io::Error::from)
                });
            }
        }
        command.env_clear();
        command.envs(self.env.iter().map(|(name, value)| (name, value)));
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        command.stdin(stdin);
        command.stdout(stdout);
        command.stderr(stderr);
        command
    }
}

/// A stream that is not piped, as the OS attaches it; `Piped` is the OS
/// pipe (the Windows spawn makes its own overlapped pipes instead).
pub(crate) fn stdio(mode: StdioMode) -> std::process::Stdio {
    match mode {
        StdioMode::Piped => std::process::Stdio::piped(),
        StdioMode::Ignore => std::process::Stdio::null(),
        StdioMode::Inherit => std::process::Stdio::inherit(),
        StdioMode::ToStderr => stderr_stdio(),
    }
}

/// The daemon's standard error as a child stream: a duplicate of the
/// daemon's own handle, writable, closed by the spawn. Without one the child
/// inherits the daemon's streams.
fn stderr_stdio() -> std::process::Stdio {
    #[cfg(unix)]
    {
        use std::os::fd::AsFd as _;
        match std::io::stderr().as_fd().try_clone_to_owned() {
            Ok(fd) => std::process::Stdio::from(fd),
            Err(_) => std::process::Stdio::inherit(),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsHandle as _;
        match std::io::stderr().as_handle().try_clone_to_owned() {
            Ok(handle) => std::process::Stdio::from(handle),
            Err(_) => std::process::Stdio::inherit(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::process::Stdio::inherit()
    }
}

/// How the leader ended, as node's `exit` names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// Which piped output a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// A chunk's receipt: the shell says whether it wants more. Dropped
/// unanswered (the shell is gone), it only frees the chunk's slot.
pub struct Delivered {
    flow: Arc<Flow>,
}

impl Delivered {
    pub(crate) fn new(flow: Arc<Flow>) -> Self {
        Self { flow }
    }

    /// The shell took the chunk; `more` is false when its stream is full.
    pub fn taken(self, more: bool) {
        if !more {
            self.flow.pause();
        }
    }
}

impl Drop for Delivered {
    fn drop(&mut self) {
        self.flow.delivered();
    }
}

/// Where a child's events go, in order; the shell turns them into streams.
pub trait EventSink: Send + Sync + 'static {
    /// A chunk of piped output.
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered);
    /// One output reached EOF (or failed): its stream ends.
    fn end(&self, stream: OutputStream);
    /// The leader's end, like node's `exit`: pipes may still drain.
    fn exit(&self, exit: RawExit);
    /// The pipes are done, like node's `close`: no byte follows.
    fn close(&self, exit: RawExit);
    /// One stdin write reached the pipe; the shell's write callback runs.
    fn stdin_written(&self);
    /// A stdin write failed; no later write reaches the child. The shell
    /// rejects the write with node's `code` and message (`write EPIPE`).
    fn stdin_error(&self, error: NodeIoError);
    /// The shell gave the group up and it outlived the hold limit: the
    /// shell kills it through its guard (the group is still held).
    fn hold_limit(&self);
    /// A diagnostic: the group is still held long after it was given up.
    fn held(&self, message: String);
}
