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
}

/// Where byte events go; the shell turns them into streams.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: ChildEvent);
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
}
