//! A real Git for the (b) cases that need one: every query is a process in a temp home,
//! never the person's configuration.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::{ConfigOutput, GitQuery};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::spawn::BoxFuture;

static NEXT: AtomicU64 = AtomicU64::new(1);

/// A fresh directory under the test temp root, removed by [`Fixture::drop`].
pub(crate) struct Fixture {
    pub(crate) root: PathBuf,
    pub(crate) home: PathBuf,
}

impl Fixture {
    pub(crate) fn new(name: &str) -> Self {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("ace-git-g2c-{name}-{}-{id}", std::process::id()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).expect("temp home");
        Self { root, home }
    }

    /// Runs Git and requires success, returning its stdout.
    pub(crate) fn git(&self, cwd: &Path, args: &[&str]) -> Vec<u8> {
        let output = self.command(cwd, &[]).args(args).output().expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    /// Creates a committed repository with the fixture files.
    pub(crate) fn repository(&self, name: &str) -> PathBuf {
        let repo = self.root.join(name);
        std::fs::create_dir_all(&repo).expect("repo");
        self.git(&repo, &["init", "--quiet"]);
        self.git(&repo, &["config", "user.email", "test@example.invalid"]);
        self.git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("file.txt"), "content\n").expect("file");
        self.git(&repo, &["add", "file.txt"]);
        self.git(&repo, &["commit", "--quiet", "-m", "initial"]);
        repo
    }

    /// A Git command with the fixture's isolated environment. The system file is a
    /// missing path under the fixture unless a caller points Git somewhere else, so no
    /// test reads the machine's own configuration.
    pub(crate) fn command(&self, cwd: &Path, env: &[(&str, &str)]) -> std::process::Command {
        let mut command = std::process::Command::new("git");
        command
            .current_dir(cwd)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join("xdg"))
            .env("GIT_CONFIG_SYSTEM", self.home.join("absent-system"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        for (key, value) in env {
            command.env(key, value);
        }
        command
    }
}

/// A Git config value that survives a path with spaces, quotes or a newline.
pub(crate) fn quote_config(path: &Path) -> String {
    let mut out = String::from("\"");
    for character in path.to_string_lossy().chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).ok();
    }
}

/// A [`GitQuery`] that answers a fixed sequence, for the malformed and absent cases.
pub(crate) struct SequenceQuery(std::sync::Mutex<std::collections::VecDeque<ConfigOutput>>);

impl SequenceQuery {
    pub(crate) fn new(answers: Vec<ConfigOutput>) -> Self {
        Self(std::sync::Mutex::new(answers.into()))
    }

    /// One `-z` listing as Git would print it.
    pub(crate) fn listing(text: &str) -> ConfigOutput {
        ConfigOutput {
            stdout: text.as_bytes().to_vec(),
            exit_code: 0,
            truncated: false,
        }
    }
}

impl GitQuery for SequenceQuery {
    fn query(&self, _args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>> {
        let next = self
            .0
            .lock()
            .ok()
            .and_then(|mut answers| answers.pop_front())
            .unwrap_or_else(|| Self::listing(""));
        Box::pin(async move { Ok(next) })
    }
}

/// A [`GitQuery`] that runs real Git in a fixture checkout.
pub(crate) struct ProcessQuery<'a> {
    pub(crate) fixture: &'a Fixture,
    pub(crate) cwd: &'a Path,
    pub(crate) env: &'a [(&'a str, &'a str)],
}

impl GitQuery for ProcessQuery<'_> {
    fn query(&self, args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>> {
        let args = args.to_vec();
        Box::pin(async move {
            let output = self
                .fixture
                .command(self.cwd, self.env)
                .args(&args)
                .output()
                .map_err(|error| GitError::new(GitErrorCode::GitMissing, error.to_string()))?;
            Ok(ConfigOutput {
                stdout: output.stdout,
                exit_code: output.status.code().unwrap_or(-1),
                truncated: false,
            })
        })
    }
}
