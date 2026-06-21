use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io, path::PathBuf, process::Stdio, time::Duration};
use thiserror::Error;
use tokio::{io::AsyncWriteExt, process::Command, time};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("missing required binary `{0}`")]
    MissingBinary(String),
    #[error("command `{program}` timed out after {timeout:?}")]
    CommandTimedOut { program: String, timeout: Duration },
    #[error("command `{program}` output exceeded {limit} bytes")]
    OutputTooLarge { program: String, limit: usize },
    #[error("failed to run `{program}`: {source}")]
    CommandIo { program: String, source: io::Error },
}

pub type Result<T> = std::result::Result<T, ProcessError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub stdin: Option<Vec<u8>>,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl CommandRequest {
    #[must_use]
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            stdin: None,
            env: BTreeMap::new(),
            timeout: DEFAULT_TIMEOUT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }

    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    #[must_use]
    pub fn stdin(mut self, stdin: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }

    #[must_use]
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    #[must_use]
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    #[must_use]
    pub fn max_output_bytes(mut self, max_output_bytes: usize) -> Self {
        self.max_output_bytes = max_output_bytes;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl CommandOutput {
    #[must_use]
    pub fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }

    #[must_use]
    pub fn stderr_string(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_string()
    }

    #[must_use]
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

#[async_trait]
pub trait ProcessRunner: Send + Sync {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput>;
}

#[derive(Debug, Default, Clone)]
pub struct TokioProcessRunner;

#[async_trait]
impl ProcessRunner for TokioProcessRunner {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput> {
        let mut command = Command::new(&request.program);
        command.args(&request.args);
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &request.env {
            command.env(key, value);
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        if request.stdin.is_some() {
            command.stdin(Stdio::piped());
        }

        let mut child = command.spawn().map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                ProcessError::MissingBinary(request.program.clone())
            } else {
                ProcessError::CommandIo {
                    program: request.program.clone(),
                    source,
                }
            }
        })?;

        if let Some(stdin) = request.stdin
            && let Some(mut child_stdin) = child.stdin.take()
        {
            child_stdin
                .write_all(&stdin)
                .await
                .map_err(|source| ProcessError::CommandIo {
                    program: request.program.clone(),
                    source,
                })?;
        }

        let output = time::timeout(request.timeout, child.wait_with_output())
            .await
            .map_err(|_| ProcessError::CommandTimedOut {
                program: request.program.clone(),
                timeout: request.timeout,
            })?
            .map_err(|source| ProcessError::CommandIo {
                program: request.program.clone(),
                source,
            })?;

        let size = output.stdout.len().saturating_add(output.stderr.len());
        if size > request.max_output_bytes {
            return Err(ProcessError::OutputTooLarge {
                program: request.program,
                limit: request.max_output_bytes,
            });
        }

        Ok(CommandOutput {
            status: output.status.code().unwrap_or(1),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_command_requests_without_shell_expansion() {
        let request = CommandRequest::new("git")
            .args(["status", "--porcelain=v1"])
            .cwd("/tmp/repo")
            .stdin("input")
            .env("A", "B")
            .timeout(Duration::from_secs(2))
            .max_output_bytes(16);
        assert_eq!(request.program, "git");
        assert_eq!(request.args, ["status", "--porcelain=v1"]);
        assert_eq!(request.stdin, Some(b"input".to_vec()));
        assert_eq!(request.env.get("A").map(String::as_str), Some("B"));
        assert_eq!(request.max_output_bytes, 16);
    }

    #[tokio::test]
    async fn maps_missing_binary() {
        let runner = TokioProcessRunner;
        let error = runner
            .run(CommandRequest::new("ace-definitely-missing-binary"))
            .await
            .expect_err("missing");
        assert!(matches!(error, ProcessError::MissingBinary(_)));
    }
}
