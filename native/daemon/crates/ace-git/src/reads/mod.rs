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
    /// True when a non-zero exit is an answer, as `allowFailure` is.
    pub allow_failure: bool,
}

impl Command {
    pub fn new(cwd: &str, args: &[&str]) -> Self {
        Self {
            cwd: cwd.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: Vec::new(),
            allow_failure: false,
        }
    }

    pub fn owned(cwd: &str, args: Vec<String>) -> Self {
        Self {
            cwd: cwd.to_owned(),
            args,
            env: Vec::new(),
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
}

/// What one read command printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

/// The port that runs one read command.
pub trait CommandPort: Send + Sync {
    fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>>;
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

/// The text of a `textOutput` read: strict UTF-8, one trailing newline removed.
pub fn text_output(bytes: &[u8]) -> Result<String, GitError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::new(GitErrorCode::MalformedOutput, "Malformed Git text output"))?;
    Ok(match text.strip_suffix('\n') {
        Some(stripped) => stripped.to_owned(),
        None => text.to_owned(),
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    //! The read commands against a real Git in a fixture checkout (never the person's
    //! configuration), reusing G2c's fixture.

    use std::path::Path;

    use super::{Command, CommandOutput, CommandPort};
    use crate::core::credentials::test_support::Fixture;
    use crate::core::error::GitError;
    use crate::core::spawn::BoxFuture;

    pub(crate) struct ProcessCommands<'a> {
        pub(crate) fixture: &'a Fixture,
    }

    impl CommandPort for ProcessCommands<'_> {
        fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                let pairs: Vec<(&str, &str)> = command
                    .env
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str()))
                    .collect();
                let output = self
                    .fixture
                    .command(Path::new(&command.cwd), &pairs)
                    .args(&command.args)
                    .output()
                    .map_err(|error| {
                        GitError::new(
                            crate::core::error::GitErrorCode::GitMissing,
                            error.to_string(),
                        )
                    })?;
                Ok(CommandOutput {
                    stdout: output.stdout,
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    exit_code: output.status.code().unwrap_or(-1),
                    truncated: false,
                })
            })
        }
    }
}
