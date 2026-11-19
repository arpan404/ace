//! How the typed outward tools start a program outside the sandbox (ADR 0171): a fixed program
//! with arguments, never a shell, in Spade's own environment so the person's sign-ins (git's
//! credential helper, their ssh agent, `gh`'s token, their Messages and Mail) are used where they
//! are kept. Injected, so tests stand in for the programs.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;

/// How a program ended.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostRan {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl HostRan {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// What it said, for the bot: its error output, else its output.
    pub fn said(&self) -> String {
        let text = if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        };
        text.trim().chars().take(4_000).collect()
    }
}

/// Why a program's end isn't known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostError {
    /// It never started.
    NotStarted(String),
    /// It started and didn't end in time, so it may have acted.
    Unknown(String),
}

pub type HostFuture = Pin<Box<dyn Future<Output = Result<HostRan, HostError>> + Send>>;

/// One program run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub dir: PathBuf,
    pub stdin: Option<String>,
}

pub trait Host: Send + Sync {
    fn run(&self, launch: Launch) -> HostFuture;
}

/// Starts real programs, ended after [`HOST_TIME`].
pub struct SystemHost;

/// The longest a push, a comment or a send may take.
pub const HOST_TIME: Duration = Duration::from_secs(120);

impl Host for SystemHost {
    fn run(&self, launch: Launch) -> HostFuture {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&launch.program);
            command
                .args(&launch.args)
                .current_dir(&launch.dir)
                // Never waits on a prompt nobody can see.
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GH_PROMPT_DISABLED", "1")
                .stdin(if launch.stdin.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = command
                .spawn()
                .map_err(|error| HostError::NotStarted(format!("{}: {error}", launch.program)))?;
            if let (Some(mut pipe), Some(text)) = (child.stdin.take(), launch.stdin) {
                let _ = pipe.write_all(text.as_bytes()).await;
            }
            match tokio::time::timeout(HOST_TIME, child.wait_with_output()).await {
                Ok(Ok(output)) => Ok(HostRan {
                    code: output.status.code(),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                }),
                Ok(Err(error)) => Err(HostError::Unknown(error.to_string())),
                Err(_) => Err(HostError::Unknown(format!(
                    "{} took longer than {} seconds",
                    launch.program,
                    HOST_TIME.as_secs()
                ))),
            }
        })
    }
}

/// A fresh folder of Spade's under `root`, removed when dropped.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(root: &Path) -> Result<Self, String> {
        let dir = root.join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&dir).map_err(|error| format!("Spade's folder: {error}"))?;
        Ok(Self(dir))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
