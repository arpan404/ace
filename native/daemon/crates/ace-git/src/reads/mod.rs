// SPDX-License-Identifier: Apache-2.0
//! The reads on the core (G3): each keeps its TypeScript command and strict parse.
//! Every command runs through a [`CommandPort`], so the eventual wiring runs it on
//! `GitCliCore` (the supervisor) and tests run it against a real Git.

use crate::core::error::{GitError, GitErrorCode};
use crate::core::spawn::BoxFuture;

pub mod blob_classifier;
pub mod changes;
pub mod conflicts;
pub mod diff;
pub mod history;
pub mod info;
pub mod line_window;
pub mod publication;
pub mod remote;
pub mod revision_lines;
pub mod status;
pub mod status_gix;
pub mod transfer_reads;
pub mod worktree_facts;

/// One read command, exactly as `GitCli.call` receives it.
#[derive(Debug, Clone)]
pub struct Command {
    pub cwd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// True when the command writes (GIT_OPTIONAL_LOCKS stays as the caller set it).
    pub write: bool,
    /// Bytes written to stdin, as `GitCli.call`'s `input`.
    pub input: Option<Vec<u8>>,
    /// The caller's capture bound, as `GitCli.call`'s `captureBytes`.
    pub capture_bytes: Option<usize>,
    /// Stop Git once the capture is full (`stopAtCapture`).
    pub stop_at_capture: bool,
    /// The work budget (`stopAfterMs`), enforced by the supervisor when wired.
    pub stop_after_ms: Option<u64>,
    /// The deadline (`timeoutMs`); `None` means the CLI's 30 s default.
    pub timeout_ms: Option<u64>,
    /// True when a non-zero exit is an answer, as `allowFailure` is.
    pub allow_failure: bool,
}

impl Command {
    pub fn new(cwd: &str, args: &[&str]) -> Self {
        Self {
            cwd: cwd.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: Vec::new(),
            write: false,
            input: None,
            capture_bytes: None,
            stop_at_capture: false,
            stop_after_ms: None,
            timeout_ms: None,
            allow_failure: false,
        }
    }

    pub fn owned(cwd: &str, args: Vec<String>) -> Self {
        Self {
            cwd: cwd.to_owned(),
            args,
            env: Vec::new(),
            write: false,
            input: None,
            capture_bytes: None,
            stop_at_capture: false,
            stop_after_ms: None,
            timeout_ms: None,
            allow_failure: false,
        }
    }

    pub fn with_env(mut self, env: &[(&str, &str)]) -> Self {
        self.env = env
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        self
    }

    pub fn allowing_failure(mut self) -> Self {
        self.allow_failure = true;
        self
    }

    pub fn writing(mut self) -> Self {
        self.write = true;
        self
    }

    pub fn with_input(mut self, input: &[u8]) -> Self {
        self.input = Some(input.to_vec());
        self
    }

    pub fn with_capture_bytes(mut self, bytes: usize) -> Self {
        self.capture_bytes = Some(bytes);
        self
    }

    pub fn stopping_at_capture(mut self) -> Self {
        self.stop_at_capture = true;
        self
    }

    pub fn stopping_after(mut self, milliseconds: u64) -> Self {
        self.stop_after_ms = Some(milliseconds);
        self
    }

    /// The caller's deadline, as `GitCli.call`'s `timeoutMs`.
    pub fn with_timeout_ms(mut self, milliseconds: u64) -> Self {
        self.timeout_ms = Some(milliseconds);
        self
    }
}

/// What one read command printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
    /// Why Git was stopped early: `capture` or `budget` (`GitCli.call`'s `stopped`).
    pub stopped: Option<String>,
}

/// The port that runs one read command.
pub trait CommandPort: Send + Sync {
    fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>>;

    /// Runs `command` feeding stdout to `consume` as it arrives, holding none of it: the caller
    /// asked for `captureBytes: 0` (`cli.ts`), so `CommandOutput.stdout` comes back empty and a
    /// capture bound never applies. Every port streams; there is no whole-capture fallback, since
    /// capturing is what such a read refuses.
    fn run_streaming<'a>(
        &'a self,
        command: Command,
        consume: &'a (dyn Fn(&[u8]) + Send + Sync),
    ) -> BoxFuture<'a, Result<CommandOutput, GitError>>;
}

/// A read whose failure is an error: the command's stderr is the message (`GitCli.call`).
pub async fn checked(port: &dyn CommandPort, command: Command) -> Result<CommandOutput, GitError> {
    let allow_failure = command.allow_failure;
    let output = port.run(command).await?;
    if !allow_failure && output.exit_code != 0 {
        return Err(GitError::new(GitErrorCode::GitFailed, output.stderr));
    }
    Ok(output)
}

/// A streaming read whose failure is an error, as [`checked`] is for a whole capture.
pub async fn checked_streaming(
    port: &dyn CommandPort,
    command: Command,
    consume: &(dyn Fn(&[u8]) + Send + Sync),
) -> Result<CommandOutput, GitError> {
    let allow_failure = command.allow_failure;
    let output = port.run_streaming(command, consume).await?;
    if !allow_failure && output.exit_code != 0 {
        return Err(GitError::new(GitErrorCode::GitFailed, output.stderr));
    }
    Ok(output)
}

/// The text of a `textOutput` read: strict UTF-8, one trailing newline removed.
pub fn text_output(bytes: &[u8]) -> Result<String, GitError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::new(GitErrorCode::MalformedOutput, "Malformed Git text output"))?;
    Ok(crate::core::paths::strip_terminator(text, false).to_owned())
}

#[cfg(test)]
mod tests {
    use super::test_support::ProcessCommands;
    use super::{Command, CommandPort};
    use crate::core::credentials::test_support::Fixture;
    use crate::core::error::GitErrorCode;

    #[tokio::test]
    async fn a_git_write_that_overruns_its_deadline_is_stopped_and_reported() {
        let fixture = Fixture::new("g4-write-deadline");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let error = port
            .run(
                Command::new(
                    &repo.to_string_lossy(),
                    &["-c", "alias.wait=!sleep 30", "wait"],
                )
                .with_timeout_ms(300),
            )
            .await
            .expect_err("stopped at its deadline");
        assert_eq!(error.code, GitErrorCode::GitTimeout);
        assert!(
            error
                .details
                .contains_key(&ace_json::JsString::from("args"))
        );
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! The read commands against a real Git in a fixture checkout (never the person's
    //! configuration), reusing G2c's fixture.

    use std::path::Path;

    use super::{Command, CommandOutput, CommandPort};
    use crate::core::credentials::test_support::Fixture;
    use crate::core::deadline::DEFAULT_TIMEOUT_MS;
    use crate::core::error::{GitError, GitErrorCode};
    use crate::core::spawn::BoxFuture;

    /// Waits for a child until the command's deadline, as `GitCli.call` does: a Git that
    /// overruns is killed and reported as `git_timeout` with its arguments.
    fn wait_with_deadline(
        child: std::process::Child,
        command: &Command,
    ) -> Result<std::process::Output, GitError> {
        let deadline = command.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let pid = child.id();
        let (sender, receiver) = std::sync::mpsc::channel();
        let waiting = std::thread::spawn(move || {
            let _ = sender.send(child.wait_with_output());
        });
        match receiver.recv_timeout(std::time::Duration::from_millis(deadline)) {
            Ok(output) => {
                let _ = waiting.join();
                output.map_err(|error| GitError::new(GitErrorCode::GitMissing, error.to_string()))
            }
            Err(_) => {
                #[cfg(unix)]
                #[allow(unsafe_code)]
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                let _ = waiting.join();
                let args = ace_json::Value::Array(
                    command
                        .args
                        .iter()
                        .map(|arg| ace_json::Value::from(arg.as_str()))
                        .collect(),
                );
                Err(GitError::new(
                    GitErrorCode::GitTimeout,
                    format!("Git exceeded {deadline}ms"),
                )
                .with_detail("args", args))
            }
        }
    }

    pub(crate) struct ProcessCommands<'a> {
        pub(crate) fixture: &'a Fixture,
    }

    impl CommandPort for ProcessCommands<'_> {
        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> BoxFuture<'a, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                use std::io::{Read, Write};
                let pairs: Vec<(&str, &str)> = command
                    .env
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str()))
                    .collect();
                let mut child = self
                    .fixture
                    .command(Path::new(&command.cwd), &pairs)
                    .args(&command.args)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|error| {
                        GitError::new(
                            crate::core::error::GitErrorCode::GitMissing,
                            error.to_string(),
                        )
                    })?;
                if let Some(input) = &command.input
                    && let Some(stdin) = child.stdin.as_mut()
                {
                    let _ = stdin.write_all(input);
                }
                drop(child.stdin.take());
                let mut stdout = child.stdout.take().ok_or_else(|| {
                    GitError::new(crate::core::error::GitErrorCode::GitMissing, "no stdout")
                })?;
                let mut buffer = vec![0u8; 8 * 1024];
                loop {
                    let read = stdout
                        .read(&mut buffer)
                        .map_err(|error| GitError::from_io(&error))?;
                    if read == 0 {
                        break;
                    }
                    consume(&buffer[..read]);
                }
                drop(stdout);
                let output = child.wait_with_output().map_err(|error| {
                    GitError::new(
                        crate::core::error::GitErrorCode::GitMissing,
                        error.to_string(),
                    )
                })?;
                Ok(CommandOutput {
                    // `captureBytes: 0`: the caller holds nothing of the stream.
                    stdout: Vec::new(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    exit_code: output.status.code().unwrap_or(-1),
                    truncated: false,
                    stopped: None,
                })
            })
        }

        fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                let pairs: Vec<(&str, &str)> = command
                    .env
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str()))
                    .collect();
                let mut child = self
                    .fixture
                    .command(Path::new(&command.cwd), &pairs)
                    .args(&command.args)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|error| {
                        GitError::new(
                            crate::core::error::GitErrorCode::GitMissing,
                            error.to_string(),
                        )
                    })?;
                if let Some(input) = &command.input
                    && let Some(mut stdin) = child.stdin.take()
                {
                    use std::io::Write;
                    let _ = stdin.write_all(input);
                }
                drop(child.stdin.take());
                let output = match wait_with_deadline(child, &command) {
                    Ok(output) => output,
                    Err(timeout) => return Err(timeout),
                };
                let mut stdout = output.stdout;
                let truncated = command
                    .capture_bytes
                    .is_some_and(|bytes| stdout.len() > bytes);
                if let Some(bytes) = command.capture_bytes {
                    stdout.truncate(bytes);
                }
                Ok(CommandOutput {
                    stdout,
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    exit_code: output.status.code().unwrap_or(-1),
                    truncated,
                    stopped: None,
                })
            })
        }
    }
}
