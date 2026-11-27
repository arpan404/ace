// SPDX-License-Identifier: Apache-2.0
//! Refuse merge or switch when incoming paths would overwrite ignored untracked files
//! (`--no-overwrite-ignore` does not block ort non-fast-forward merges).

use std::collections::HashSet;

use crate::core::decode::nul;
use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked, text_output};

fn dirty(message: &str) -> GitError {
    GitError::new(GitErrorCode::DirtyWorktree, message)
}

fn ensure_complete(output: &crate::reads::CommandOutput, context: &str) -> Result<(), GitError> {
    if output.truncated || output.stopped.is_some() {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            format!("Could not finish scanning {context} for overwrite safety"),
        ));
    }
    Ok(())
}

async fn ignored_untracked(port: &dyn CommandPort, root: &str) -> Result<Vec<String>, GitError> {
    let listed = checked(
        port,
        Command::new(root, &["ls-files", "-o", "-i", "--exclude-standard", "-z"])
            .with_capture_bytes(8 * 1_048_576),
    )
    .await?;
    ensure_complete(&listed, "ignored untracked files")?;
    Ok(nul(&listed.stdout)?
        .into_iter()
        .map(|path| path.trim_end_matches('/').to_owned())
        .filter(|path| !path.is_empty())
        .collect())
}

async fn merge_incoming_paths(
    port: &dyn CommandPort,
    root: &str,
    revision: &str,
) -> Result<HashSet<String>, GitError> {
    let diff = checked(
        port,
        Command::new(
            root,
            &[
                "diff",
                "--name-only",
                "-z",
                "--no-renames",
                &format!("HEAD...{revision}"),
            ],
        )
        .with_capture_bytes(8 * 1_048_576),
    )
    .await?;
    ensure_complete(&diff, "incoming merge paths")?;
    Ok(nul(&diff.stdout)?
        .into_iter()
        .map(|path| path.trim_end_matches('/').to_owned())
        .filter(|path| !path.is_empty())
        .collect())
}

async fn switch_target_paths(
    port: &dyn CommandPort,
    root: &str,
    tip: &str,
) -> Result<HashSet<String>, GitError> {
    let head_tree = checked(
        port,
        Command::new(root, &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]).allowing_failure(),
    )
    .await?;
    let listed = if head_tree.exit_code == 0 {
        let head = text_output(&head_tree.stdout)?;
        checked(
            port,
            Command::new(
                root,
                &[
                    "diff-tree",
                    "-r",
                    "--no-commit-id",
                    "--name-only",
                    "-z",
                    "--end-of-options",
                    &head,
                    tip,
                ],
            )
            .with_capture_bytes(8 * 1_048_576),
        )
        .await?
    } else {
        checked(
            port,
            Command::new(
                root,
                &[
                    "ls-tree",
                    "-r",
                    "--name-only",
                    "-z",
                    "--end-of-options",
                    tip,
                ],
            )
            .with_capture_bytes(8 * 1_048_576),
        )
        .await?
    };
    ensure_complete(&listed, "target tree paths")?;
    Ok(nul(&listed.stdout)?
        .into_iter()
        .map(|path| path.trim_end_matches('/').to_owned())
        .filter(|path| !path.is_empty())
        .collect())
}

async fn switch_tip(port: &dyn CommandPort, root: &str, branch: &str) -> Result<String, GitError> {
    let tip = checked(
        port,
        Command::new(
            root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &format!("refs/heads/{branch}^{{commit}}"),
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if tip.exit_code != 0 {
        return Err(GitError::new(GitErrorCode::InvalidRef, "Invalid branch"));
    }
    text_output(&tip.stdout)
}

/// True when any ignored path collides with an incoming path by exact name or
/// path-component prefix (file vs directory in either direction).
pub(crate) fn paths_overlap(ignored: &[String], incoming: &HashSet<String>) -> bool {
    let mut incoming_exact: HashSet<&str> = HashSet::with_capacity(incoming.len());
    let mut incoming_ancestors: HashSet<&str> = HashSet::new();
    for path in incoming {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            continue;
        }
        incoming_exact.insert(trimmed);
        for (idx, byte) in trimmed.bytes().enumerate() {
            if byte == b'/' && idx > 0 {
                incoming_ancestors.insert(&trimmed[..idx]);
            }
        }
    }
    for path in ignored {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            continue;
        }
        if incoming_exact.contains(trimmed) || incoming_ancestors.contains(trimmed) {
            return true;
        }
        for (idx, byte) in trimmed.bytes().enumerate() {
            if byte == b'/' && idx > 0 && incoming_exact.contains(&trimmed[..idx]) {
                return true;
            }
        }
    }
    false
}

/// Before a merge, refuse when an ignored untracked path would be clobbered.
pub async fn refuse_merge_overwrite(
    port: &dyn CommandPort,
    root: &str,
    revision: &str,
) -> Result<(), GitError> {
    let ignored = ignored_untracked(port, root).await?;
    if ignored.is_empty() {
        return Ok(());
    }
    let incoming = merge_incoming_paths(port, root, revision).await?;
    if paths_overlap(&ignored, &incoming) {
        return Err(dirty(
            "Git couldn't start the merge: move untracked files it would overwrite",
        ));
    }
    Ok(())
}

/// Before a switch, refuse when the target branch would overwrite ignored untracked paths.
pub async fn refuse_switch_overwrite(
    port: &dyn CommandPort,
    root: &str,
    branch: &str,
) -> Result<(), GitError> {
    let ignored = ignored_untracked(port, root).await?;
    if ignored.is_empty() {
        return Ok(());
    }
    let tip = switch_tip(port, root, branch).await?;
    let incoming = switch_target_paths(port, root, &tip).await?;
    if paths_overlap(&ignored, &incoming) {
        return Err(dirty(
            "Git couldn't switch branches: move untracked files it would overwrite",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;
    use crate::writes::branches::switch_branch;
    use crate::writes::merge::start_merge;

    fn assert_ignored(fixture: &Fixture, repo: &std::path::Path, path: &str) {
        let out = fixture
            .command(repo, &[])
            .args(["check-ignore", "-v", path])
            .output()
            .expect("check-ignore");
        assert!(out.status.success(), "{path} must be ignored");
    }

    #[tokio::test]
    async fn merge_refuses_an_ignored_untracked_file_the_incoming_branch_tracks() {
        let fixture = Fixture::new("g4-overlap-merge");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["checkout", "--quiet", "-b", "incoming"]);
        std::fs::write(repo.join("local.env"), "tracked\n").expect("write");
        fixture.git(&repo, &["add", "local.env"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "incoming"]);
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join(".gitignore"), "local.env\n").expect("ignore");
        std::fs::write(repo.join("local.env"), "secret\n").expect("local");
        fixture.git(&repo, &["add", ".gitignore"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "ignore"]);
        assert_ignored(&fixture, &repo, "local.env");
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let incoming = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "incoming"]))
            .trim_end()
            .to_owned();
        let index_before = std::fs::read(repo.join(".git/index")).expect("index");
        let local_before = std::fs::read(repo.join("local.env")).expect("local");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            start_merge(&port, &root, &incoming, &head, "merge")
                .await
                .expect_err("merge")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            std::fs::read(repo.join("local.env")).expect("local"),
            local_before
        );
        assert_eq!(
            std::fs::read(repo.join(".git/index")).expect("index"),
            index_before
        );
    }

    #[tokio::test]
    async fn switch_refuses_an_ignored_untracked_file_the_target_branch_tracks() {
        let fixture = Fixture::new("g4-overlap-switch");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["checkout", "--quiet", "-b", "incoming"]);
        std::fs::write(repo.join("local.env"), "tracked\n").expect("write");
        fixture.git(&repo, &["add", "local.env"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "incoming"]);
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join(".gitignore"), "local.env\n").expect("ignore");
        std::fs::write(repo.join("local.env"), "secret\n").expect("local");
        fixture.git(&repo, &["add", ".gitignore"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "ignore"]);
        assert_ignored(&fixture, &repo, "local.env");
        let local_before = std::fs::read(repo.join("local.env")).expect("local");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            switch_branch(&port, &root, "incoming", false)
                .await
                .expect_err("switch")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            std::fs::read(repo.join("local.env")).expect("local"),
            local_before
        );
    }

    struct TruncatingCommands<'a> {
        inner: ProcessCommands<'a>,
        word: &'a str,
        stopped: Option<&'a str>,
    }

    impl CommandPort for TruncatingCommands<'_> {
        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> crate::core::spawn::BoxFuture<'a, Result<crate::reads::CommandOutput, GitError>>
        {
            self.inner.run_streaming(command, consume)
        }

        fn run(
            &self,
            command: Command,
        ) -> crate::core::spawn::BoxFuture<'_, Result<crate::reads::CommandOutput, GitError>>
        {
            let matches = command.args.iter().any(|arg| arg == self.word);
            let stopped = self.stopped.map(str::to_owned);
            let fut = self.inner.run(command);
            Box::pin(async move {
                let mut out = fut.await?;
                if matches {
                    out.truncated = stopped.is_none();
                    out.stopped = stopped;
                }
                Ok(out)
            })
        }
    }

    #[tokio::test]
    async fn truncated_or_stopped_overlap_scans_fail_closed() {
        let fixture = Fixture::new("g4-overlap-truncated");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["checkout", "--quiet", "-b", "incoming"]);
        std::fs::write(repo.join("other.txt"), "other\n").expect("write");
        fixture.git(&repo, &["add", "other.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "incoming"]);
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join(".gitignore"), "ignored.env\n").expect("ignore");
        std::fs::write(repo.join("ignored.env"), "secret\n").expect("local");
        fixture.git(&repo, &["add", ".gitignore"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "ignore"]);
        let incoming = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "incoming"]))
            .trim_end()
            .to_owned();
        let root = repo.to_string_lossy();

        // Truncated ls-files must fail closed on both merge and switch.
        let trunc_ls = TruncatingCommands {
            inner: ProcessCommands { fixture: &fixture },
            word: "ls-files",
            stopped: None,
        };
        assert_eq!(
            refuse_merge_overwrite(&trunc_ls, &root, &incoming)
                .await
                .expect_err("truncated ls-files merge")
                .code,
            GitErrorCode::OutputTooLarge
        );
        assert_eq!(
            refuse_switch_overwrite(&trunc_ls, &root, "incoming")
                .await
                .expect_err("truncated ls-files switch")
                .code,
            GitErrorCode::OutputTooLarge
        );

        // Stopped ls-files must also fail closed.
        let stopped_ls = TruncatingCommands {
            inner: ProcessCommands { fixture: &fixture },
            word: "ls-files",
            stopped: Some("capture"),
        };
        assert_eq!(
            refuse_merge_overwrite(&stopped_ls, &root, &incoming)
                .await
                .expect_err("stopped ls-files")
                .code,
            GitErrorCode::OutputTooLarge
        );

        // Truncated diff/diff-tree must fail closed too.
        let trunc_diff = TruncatingCommands {
            inner: ProcessCommands { fixture: &fixture },
            word: "--name-only",
            stopped: None,
        };
        assert_eq!(
            refuse_merge_overwrite(&trunc_diff, &root, &incoming)
                .await
                .expect_err("truncated incoming merge")
                .code,
            GitErrorCode::OutputTooLarge
        );
        assert_eq!(
            refuse_switch_overwrite(&trunc_diff, &root, "incoming")
                .await
                .expect_err("truncated incoming switch")
                .code,
            GitErrorCode::OutputTooLarge
        );
    }

    #[tokio::test]
    async fn merge_and_switch_refuse_file_versus_directory_ignored_collisions() {
        // Direction 1: ignored file `slot` vs incoming directory `slot/tracked.txt`.
        let fixture = Fixture::new("g4-overlap-file-vs-dir");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["checkout", "--quiet", "-b", "incoming"]);
        std::fs::create_dir_all(repo.join("slot")).expect("dir");
        std::fs::write(repo.join("slot/tracked.txt"), "tracked\n").expect("write");
        fixture.git(&repo, &["add", "slot/tracked.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "incoming dir"]);
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join(".gitignore"), "slot\n").expect("ignore");
        std::fs::write(repo.join("slot"), "secret-file\n").expect("local");
        fixture.git(&repo, &["add", ".gitignore"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "ignore slot"]);
        assert_ignored(&fixture, &repo, "slot");
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let incoming = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "incoming"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            start_merge(&port, &root, &incoming, &head, "merge")
                .await
                .expect_err("merge file vs dir")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            switch_branch(&port, &root, "incoming", false)
                .await
                .expect_err("switch file vs dir")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("slot")).expect("kept"),
            "secret-file\n"
        );

        // Direction 2: ignored nested file `slot/secret.env` vs incoming regular file `slot`.
        let fixture2 = Fixture::new("g4-overlap-dir-vs-file");
        let repo2 = fixture2.repository("repo");
        fixture2.git(&repo2, &["checkout", "--quiet", "-b", "incoming"]);
        std::fs::write(repo2.join("slot"), "tracked-file\n").expect("write");
        fixture2.git(&repo2, &["add", "slot"]);
        fixture2.git(&repo2, &["commit", "--quiet", "-m", "incoming file"]);
        fixture2.git(&repo2, &["checkout", "--quiet", "main"]);
        std::fs::write(repo2.join(".gitignore"), "slot/\n").expect("ignore");
        std::fs::create_dir_all(repo2.join("slot")).expect("dir");
        std::fs::write(repo2.join("slot/secret.env"), "nested-secret\n").expect("local");
        fixture2.git(&repo2, &["add", ".gitignore"]);
        fixture2.git(&repo2, &["commit", "--quiet", "-m", "ignore slot dir"]);
        assert_ignored(&fixture2, &repo2, "slot/secret.env");
        let head2 = String::from_utf8_lossy(&fixture2.git(&repo2, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let incoming2 = String::from_utf8_lossy(&fixture2.git(&repo2, &["rev-parse", "incoming"]))
            .trim_end()
            .to_owned();
        let port2 = ProcessCommands { fixture: &fixture2 };
        let root2 = repo2.to_string_lossy();
        assert_eq!(
            start_merge(&port2, &root2, &incoming2, &head2, "merge")
                .await
                .expect_err("merge dir vs file")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            switch_branch(&port2, &root2, "incoming", false)
                .await
                .expect_err("switch dir vs file")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            std::fs::read_to_string(repo2.join("slot/secret.env")).expect("kept"),
            "nested-secret\n"
        );
    }

    #[tokio::test]
    async fn switch_refuses_ignored_file_tracked_in_target_tree_even_when_unchanged_since_merge_base()
     {
        let fixture = Fixture::new("g4-overlap-switch-tree");
        let repo = fixture.repository("repo");
        // Both branches inherit `shared.env` from the merge base.
        std::fs::write(repo.join("shared.env"), "base\n").expect("write");
        fixture.git(&repo, &["add", "shared.env"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "base tracks shared"]);
        // Target branch does NOT touch `shared.env` at all.
        fixture.git(&repo, &["checkout", "--quiet", "-b", "target"]);
        std::fs::write(repo.join("other.txt"), "target\n").expect("write");
        fixture.git(&repo, &["add", "other.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "target unrelated"]);
        // Main deletes `shared.env`, ignores it, and has an untracked ignored `shared.env`.
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        fixture.git(&repo, &["rm", "--quiet", "shared.env"]);
        std::fs::write(repo.join(".gitignore"), "shared.env\n").expect("ignore");
        fixture.git(&repo, &["add", ".gitignore"]);
        fixture.git(
            &repo,
            &["commit", "--quiet", "-m", "main drops and ignores shared"],
        );
        std::fs::write(repo.join("shared.env"), "local-secret\n").expect("local");
        assert_ignored(&fixture, &repo, "shared.env");

        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            switch_branch(&port, &root, "target", false)
                .await
                .expect_err("switch must compare actual trees, not merge-base diff")
                .code,
            GitErrorCode::DirtyWorktree
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("shared.env")).expect("kept"),
            "local-secret\n"
        );
    }
}
