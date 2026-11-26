// SPDX-License-Identifier: Apache-2.0
//! Serial turns, guarded opens, and index-stage binding for G4 mutations.

pub mod open;
pub mod stage;

use std::io::ErrorKind;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::core::deadline::LONG_WRITE_TIMEOUT_MS;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::core::serial::{SerialTurn, global_serial};
use crate::reads::{Command, CommandPort, checked, text_output};

/// Whether the index exists and its SHA-256 when it does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexFingerprint {
    Absent,
    Present(String),
}

/// One checkout's HEAD OID and index state under a serial turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutSnapshot {
    pub head: Option<String>,
    pub index: IndexFingerprint,
}

fn head_moved(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::HeadMoved, message)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn index_path(port: &dyn CommandPort, root: &str) -> Result<String, GitError> {
    let output = checked(
        port,
        Command::new(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        ),
    )
    .await?;
    let path = text_output(&output.stdout)?;
    Ok(if Path::new(&path).is_absolute() {
        path
    } else {
        paths::resolve(root, &path)
    })
}

async fn index_fingerprint(port: &dyn CommandPort, root: &str) -> Result<IndexFingerprint, GitError> {
    let path = index_path(port, root).await?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(IndexFingerprint::Present(digest(&bytes))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(IndexFingerprint::Absent),
        Err(error) => Err(GitError::from_io(&error)),
    }
}

/// The canonical root's turn for one write operation.
pub async fn serial_turn(root: &str) -> Result<(String, SerialTurn), GitError> {
    let key = paths::serial_key(root)?;
    let turn = global_serial().acquire(&key, None).await?;
    Ok((key, turn))
}

/// HEAD and the index fingerprint under an already-acquired serial turn.
pub async fn checkout_snapshot(
    port: &dyn CommandPort,
    root: &str,
) -> Result<CheckoutSnapshot, GitError> {
    Ok(CheckoutSnapshot {
        head: crate::reads::info::head(port, root).await?,
        index: index_fingerprint(port, root).await?,
    })
}

impl CheckoutSnapshot {
    pub fn assert_head(&self, expected: Option<&str>) -> Result<(), GitError> {
        if self.head.as_deref() != expected {
            return Err(head_moved("HEAD moved; refresh first"));
        }
        Ok(())
    }

    pub async fn assert_index_unchanged(
        &self,
        port: &dyn CommandPort,
        root: &str,
    ) -> Result<(), GitError> {
        let IndexFingerprint::Present(expected) = &self.index else {
            return Ok(());
        };
        let current = index_fingerprint(port, root).await?;
        let IndexFingerprint::Present(now) = current else {
            return Err(head_moved("The index changed meanwhile; refresh first"));
        };
        if &now != expected {
            return Err(head_moved("The index changed meanwhile; refresh first"));
        }
        Ok(())
    }
}

/// A Git write that carries the long-write deadline TypeScript sets.
pub fn long_writing(mut command: Command) -> Command {
    command.write = true;
    command.stop_after_ms = Some(LONG_WRITE_TIMEOUT_MS);
    command
}

pub use open::{verify_worktree_revision, write_worktree_verified};
pub use stage::{StageLine, stage_lines, stage_removal, stage_resolved_bytes, stage_side_entry};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::core::deadline::LONG_WRITE_TIMEOUT_MS;
    use crate::reads::test_support::ProcessCommands;
    use crate::writes::commit::{CommitRequest, commit_changes};

    #[test]
    fn long_writing_carries_the_six_hundred_second_deadline() {
        let command = long_writing(Command::new("/repo", &["merge", "--abort"]));
        assert!(command.write);
        assert_eq!(command.stop_after_ms, Some(LONG_WRITE_TIMEOUT_MS));
    }

    #[tokio::test]
    async fn the_first_commit_succeeds_when_git_init_left_no_index() {
        let fixture = Fixture::new("g4-empty-index");
        let repo = fixture.root.join("fresh");
        std::fs::create_dir_all(&repo).expect("dir");
        fixture.git(&repo, &["init", "--quiet"]);
        fixture.git(&repo, &["config", "user.email", "test@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("first.txt"), "first\n").expect("file");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        let mut request = CommitRequest {
            message: "first".to_owned(),
            expected_head: None,
            paths: None,
            staged_only: false,
            stage_listed: None,
            draft_fingerprint: None,
        };
        commit_changes(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &request,
            false,
        )
        .await
        .expect("first commit");
        request.expected_head = crate::reads::info::head(&port, &root).await.expect("head");
        assert!(matches!(
            checkout_snapshot(&port, &root).await.expect("snapshot").index,
            IndexFingerprint::Present(_)
        ));
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::reads::test_support::ProcessCommands;

    /// Runs a hook when the `nth` Git invocation matches `when` (substring on args).
    pub struct InterceptingCommands<'a> {
        pub inner: ProcessCommands<'a>,
        pub when: &'static str,
        pub after: usize,
        pub hook: Box<dyn Fn() + Send + Sync>,
        pub seen: std::sync::atomic::AtomicUsize,
    }

    impl CommandPort for InterceptingCommands<'_> {
        fn run(
            &self,
            command: Command,
        ) -> crate::core::spawn::BoxFuture<'_, Result<crate::reads::CommandOutput, GitError>>
        {
            let matches = command.args.iter().any(|arg| arg.contains(self.when));
            if matches {
                let count = self.seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if count == self.after {
                    (self.hook)();
                }
            }
            self.inner.run(command)
        }
    }
}