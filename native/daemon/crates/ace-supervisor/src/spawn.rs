// SPDX-License-Identifier: Apache-2.0
//! Spawning supervised processes: own process group on POSIX (including
//! grandchildren holding the pipes), a Job Object on Windows, byte events
//! to the shell, stdin by message, and the stop escalation the shell's
//! stop promises resolve on. Ports the spawn half of `process.ts`.

use crate::errors::SupervisorError;
use std::collections::HashMap;

/// How a standard stream is attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioMode {
    /// Piped and pumped as byte events.
    Piped,
    /// `/dev/null`.
    Ignore,
    /// The daemon's own stream (interactive children).
    Inherit,
}

/// What to spawn: the command, its arguments, where and as whom it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    /// Platform override for the Windows branch; tests inject win32.
    pub windows: bool,
    /// Whole-tree stop used on Windows instead of group signals.
    pub windows_batch: bool,
    pub stdin: StdioMode,
    pub stdout: StdioMode,
    pub stderr: StdioMode,
    /// Natural exit kills descendants by default, agent dev servers included.
    pub kill_group_on_exit: bool,
}

impl SpawnSpec {
    /// Validates what the kernel will refuse: an empty command.
    pub fn validate(&self) -> Result<(), SupervisorError> {
        if self.command.is_empty() {
            return Err(SupervisorError::InvalidInput("empty command".to_owned()));
        }
        Ok(())
    }
}

/// How the child ended, before the shell names the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// Byte events the pumps deliver, in arrival order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Exit(RawExit),
    StdinError(String),
    /// A retained stop confirmed the tree gone.
    TreeGone,
    /// A forced Windows stop did not end the tree; it stays owned meanwhile.
    StopFailed(String),
}

/// Where byte events go; the shell turns them into streams.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: ChildEvent);
}

/// A stop escalation the stop task carries out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopRequest {
    pub grace_ms: u64,
}

/// Validates a stop grace from the shell.
pub fn check_grace_ms(grace_ms: f64) -> Result<u64, SupervisorError> {
    if !grace_ms.is_finite() || grace_ms < 0.0 {
        return Err(SupervisorError::InvalidInput("Invalid graceMs".to_owned()));
    }
    Ok(grace_ms as u64)
}

/// Names of the shells' byte events, shared with the binding.
pub const EVENT_STDOUT: &str = "stdout";
pub const EVENT_STDERR: &str = "stderr";
pub const EVENT_EXIT: &str = "exit";
pub const EVENT_STDIN_ERROR: &str = "stdin-error";

/// The stop escalation: terminate, then destroy after the grace. A later
/// stop with a shorter grace moves the destroy earlier, never later.
pub async fn run_stop_plan<T: crate::stop::StopTree + Sync>(
    tree: &T,
    pid: u32,
    mut requests: tokio::sync::mpsc::UnboundedReceiver<StopRequest>,
    mut exited: tokio::sync::oneshot::Receiver<()>,
) {
    use tokio::time::{Duration, Instant, sleep};
    let mut deadline: Option<Instant> = None;
    loop {
        match deadline {
            None => {
                tokio::select! {
                    request = requests.recv() => {
                        let Some(request) = request else { return };
                        deadline =
                            Some(Instant::now() + Duration::from_millis(request.grace_ms));
                        tree.terminate(pid);
                    }
                    _ = &mut exited => return,
                }
            }
            Some(end) => {
                tokio::select! {
                    request = requests.recv() => {
                        let Some(request) = request else { return };
                        let earlier = Instant::now() + Duration::from_millis(request.grace_ms);
                        if earlier < end {
                            deadline = Some(earlier);
                        }
                    }
                    _ = sleep(end.saturating_duration_since(Instant::now())) => {
                        tree.destroy(pid);
                        return;
                    }
                    _ = &mut exited => return,
                }
            }
        }
    }
}

/// Reads every chunk of `reader` as byte events until EOF or error.
pub async fn pump_stream<E: EventSink, R: tokio::io::AsyncRead + Unpin>(
    events: &E,
    mut reader: R,
    is_stderr: bool,
) {
    let mut buffer = vec![0u8; 65_536];
    loop {
        let read = {
            use tokio::io::AsyncReadExt as _;
            reader.read(&mut buffer).await
        };
        match read {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let chunk = buffer[..n].to_vec();
                if is_stderr {
                    events.emit(ChildEvent::Stderr(chunk));
                } else {
                    events.emit(ChildEvent::Stdout(chunk));
                }
            }
        }
    }
}

/// Shortens an absolute deadline to an earlier grace; never pushes it back.
pub fn shorten_deadline(current: Option<u64>, now_ms: u64, grace_ms: u64) -> (Option<u64>, bool) {
    let at = now_ms.saturating_add(grace_ms);
    match current {
        Some(end) if end <= at => (Some(end), false),
        _ => (Some(at), true),
    }
}

/// Env pairs for a spawn: names and values as the kernel takes them.
pub fn env_block(env: &[(String, String)]) -> HashMap<String, String> {
    env.iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_command_cannot_spawn() {
        let spec = SpawnSpec {
            command: String::new(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            windows: false,
            windows_batch: false,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
            kill_group_on_exit: true,
        };
        assert!(spec.validate().is_err());
    }

    #[test]
    fn stop_grace_must_be_a_finite_nonnegative_number() {
        assert_eq!(check_grace_ms(500.0), Ok(500));
        assert!(check_grace_ms(f64::NAN).is_err());
        assert!(check_grace_ms(-1.0).is_err());
    }

    #[test]
    fn shorter_grace_moves_the_deadline_earlier_never_later() {
        assert_eq!(shorten_deadline(None, 1_000, 500), (Some(1_500), true));
        assert_eq!(
            shorten_deadline(Some(1_500), 1_000, 100),
            (Some(1_100), true)
        );
        assert_eq!(
            shorten_deadline(Some(1_100), 1_000, 500),
            (Some(1_100), false)
        );
    }
}
