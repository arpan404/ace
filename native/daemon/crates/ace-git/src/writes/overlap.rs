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

async fn ignored_untracked(port: &dyn CommandPort, root: &str) -> Result<Vec<String>, GitError> {
    let listed = checked(
        port,
        Command::new(
            root,
            &[
                "ls-files",
                "-o",
                "-i",
                "--exclude-standard",
                "-z",
            ],
        )
        .with_capture_bytes(8 * 1_048_576),
    )
    .await?;
    Ok(nul(&listed.stdout)?
        .into_iter()
        .map(String::from)
        .filter(|path| !path.is_empty())
        .collect())
}

async fn incoming_paths(
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
                "--find-renames",
                &format!("HEAD...{revision}"),
            ],
        )
        .with_capture_bytes(8 * 1_048_576),
    )
    .await?;
    Ok(nul(&diff.stdout)?
        .into_iter()
        .map(String::from)
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
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Invalid branch",
        ));
    }
    text_output(&tip.stdout)
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
    let incoming = incoming_paths(port, root, revision).await?;
    if ignored.iter().any(|path| incoming.contains(path)) {
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
    let incoming = incoming_paths(port, root, &tip).await?;
    if ignored.iter().any(|path| incoming.contains(path)) {
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
        let out = fixture.command(repo, &[]).args(["check-ignore", "-v", path]).output().expect("check-ignore");
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
        assert_eq!(std::fs::read(repo.join("local.env")).expect("local"), local_before);
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
        assert_eq!(std::fs::read(repo.join("local.env")).expect("local"), local_before);
    }
}