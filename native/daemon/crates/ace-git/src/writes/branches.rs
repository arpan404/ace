// SPDX-License-Identifier: Apache-2.0
//! Branch writes (`ref-conflict.ts`, `actions.ts`'s `switchBranch`, `branch-cleanup.ts` and
//! `transfer-refs.ts`'s `createBranch`, G4): refs are files, so branch `ace` and branch
//! `ace/1f2e` cannot both exist; a switch refuses conflicts and (unless allowed) changes; a
//! cleanup deletes only a branch still at the expected commit and not checked out.
//!
//! Proof: `client-actions.process`, `branch-cleanup.process` and `transfer-bundle.process`.

use crate::core::decode::hash_schema;
use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked, text_output};
use crate::writes::bind::{long_writing, serial_turn};

fn conflict(branch: &str, existing: &str) -> GitError {
    GitError::new(
        GitErrorCode::RefConflict,
        format!("Branch {branch} can't be created while branch {existing} exists"),
    )
    .with_detail("branch", ace_json::Value::from(branch))
    .with_detail("conflictsWith", ace_json::Value::from(existing))
}

/// Names the existing branch that blocks `branch`, before Git fails with a lock error.
pub async fn assert_no_ref_conflict(
    port: &dyn CommandPort,
    root: &str,
    branch: &str,
) -> Result<(), GitError> {
    let parts: Vec<&str> = branch.split('/').collect();
    for length in 1..parts.len() {
        let prefix = parts[..length].join("/");
        let found = checked(
            port,
            Command::new(
                root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{prefix}"),
                ],
            )
            .allowing_failure(),
        )
        .await?;
        if found.exit_code == 0 {
            return Err(conflict(branch, &prefix));
        }
    }
    let below = checked(
        port,
        Command::new(
            root,
            &[
                "for-each-ref",
                "--count=1",
                "--format=%(refname:short)",
                &format!("refs/heads/{branch}/"),
            ],
        )
        .with_capture_bytes(8192),
    )
    .await?;
    let existing = String::from_utf8_lossy(&below.stdout).trim().to_owned();
    if existing.is_empty() {
        Ok(())
    } else {
        Err(conflict(branch, &existing))
    }
}

/// `switchBranch`: switch the checkout, refusing conflicts and (unless allowed) any change.
pub async fn switch_branch(
    port: &dyn CommandPort,
    root: &str,
    branch: &str,
    allow_uncommitted: bool,
) -> Result<(), GitError> {
    let valid = checked(
        port,
        Command::new(root, &["check-ref-format", "--branch", branch]).allowing_failure(),
    )
    .await?;
    if branch.is_empty() || branch.starts_with('-') || valid.exit_code != 0 {
        return Err(GitError::new(GitErrorCode::InvalidRef, "Invalid branch"));
    }
    let status = crate::reads::status::status(port, root, &[]).await?;
    if !status.conflicted.is_empty() {
        return Err(GitError::new(
            GitErrorCode::Conflicts,
            "Resolve conflicts before switching",
        ));
    }
    if !allow_uncommitted
        && (!status.staged.is_empty()
            || !status.unstaged.is_empty()
            || !status.untracked.is_empty())
    {
        return Err(GitError::new(
            GitErrorCode::DirtyWorktree,
            "Commit or explicitly allow uncommitted changes",
        ));
    }
    let (_key, _serial) = serial_turn(root).await?;
    checked(
        port,
        long_writing(Command::new(
            root,
            &[
                "switch",
                "--no-guess",
                "--no-overwrite-ignore",
                "--",
                branch,
            ],
        ))
        .with_env(&[("GIT_TRACE2_EVENT", "1")]),
    )
    .await?;
    Ok(())
}

/// `deleteUnchangedBranch`: delete only a branch that still holds `expected_head` and is free.
pub async fn delete_unchanged_branch(
    port: &dyn CommandPort,
    root: &str,
    branch: &str,
    expected_head: &str,
) -> Result<(), GitError> {
    let head = hash_schema(expected_head)
        .ok_or_else(|| GitError::new(GitErrorCode::InvalidArgument, "Invalid expected head"))?;
    if branch.is_empty() || branch.chars().count() > 256 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Invalid cleanup branch",
        ));
    }
    let reference = format!("refs/heads/{branch}");
    let valid = checked(
        port,
        Command::new(root, &["check-ref-format", &reference]).allowing_failure(),
    )
    .await?;
    if branch.starts_with('-') || valid.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Invalid cleanup branch",
        ));
    }
    let symbolic = checked(
        port,
        Command::new(root, &["symbolic-ref", "--quiet", &reference]).allowing_failure(),
    )
    .await?;
    if symbolic.exit_code == 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Cleanup branch is a symbolic ref",
        ));
    }
    let current = checked(
        port,
        Command::new(
            root,
            &["show-ref", "--verify", "--hash", "--no-deref", &reference],
        )
        .allowing_failure(),
    )
    .await?;
    if current.exit_code != 0 {
        return Ok(());
    }
    if text_output(&current.stdout)? != head {
        return Err(GitError::new(
            GitErrorCode::RestoreCollision,
            "Cleanup branch changed",
        ));
    }
    let trees = crate::reads::info::worktrees(port, root, cfg!(windows)).await?;
    if trees
        .iter()
        .any(|tree| tree.branch.as_deref() == Some(branch))
    {
        return Err(GitError::new(
            GitErrorCode::RestoreCollision,
            "Cleanup branch is still checked out",
        ));
    }
    let (_key, _serial) = serial_turn(root).await?;
    // Compare-and-delete prevents a changed ref being removed between observation and mutation.
    checked(
        port,
        long_writing(Command::new(
            root,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "update-ref",
                "--no-deref",
                "-d",
                &reference,
                &head,
            ],
        )),
    )
    .await?;
    Ok(())
}

/// Create `refs/heads/<name>` at `commit`; `branch_exists` when it is already there.
pub async fn create_branch(
    port: &dyn CommandPort,
    root: &str,
    name: &str,
    commit: &str,
) -> Result<(), GitError> {
    let valid = checked(
        port,
        Command::new(root, &["check-ref-format", "--branch", name]).allowing_failure(),
    )
    .await?;
    if name.is_empty() || name.starts_with('-') || valid.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            format!("Invalid branch name: {name}"),
        ));
    }
    let sha = crate::reads::diff::resolve_commit(port, root, commit).await?;
    let result = checked(
        port,
        Command::new(
            root,
            &[
                "update-ref",
                &format!("refs/heads/{name}"),
                &sha,
                &"0".repeat(sha.len()),
            ],
        )
        .writing()
        .allowing_failure(),
    )
    .await?;
    if result.exit_code == 0 {
        return Ok(());
    }
    let exists = checked(
        port,
        Command::new(
            root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if exists.exit_code == 0 {
        return Err(GitError::new(
            GitErrorCode::BranchExists,
            format!("Branch already exists: {name}"),
        ));
    }
    Err(GitError::new(
        GitErrorCode::RefConflict,
        format!("Cannot create branch {name}"),
    )
    .with_detail("stderr", ace_json::Value::from(result.stderr.trim())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn creating_switching_and_deleting_a_branch_refuse_what_moved() {
        let fixture = Fixture::new("g4-branches");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        create_branch(&port, &root, "feature", "HEAD")
            .await
            .expect("create");
        assert_eq!(
            create_branch(&port, &root, "feature", "HEAD")
                .await
                .expect_err("exists")
                .code,
            GitErrorCode::BranchExists
        );
        switch_branch(&port, &root, "feature", false)
            .await
            .expect("switch");
        let head = crate::reads::info::head(&port, &root).await.expect("head");
        // A missing or changed branch is a cleanup refusal only once it exists and moved.
        delete_unchanged_branch(&port, &root, "absent", &head.clone().unwrap_or_default())
            .await
            .expect("absent");
        let feature_head = crate::reads::info::head(&port, &root).await.expect("head");
        assert_eq!(
            delete_unchanged_branch(
                &port,
                &root,
                "feature",
                &feature_head.clone().unwrap_or_default(),
            )
            .await
            .expect_err("checked out")
            .code,
            GitErrorCode::RestoreCollision
        );
        switch_branch(&port, &root, "main", false)
            .await
            .expect("back");
        std::fs::write(repo.join("file.txt"), "dirty\n").expect("dirty");
        assert_eq!(
            switch_branch(&port, &root, "feature", false)
                .await
                .expect_err("dirty")
                .code,
            GitErrorCode::DirtyWorktree
        );
        switch_branch(&port, &root, "feature", true)
            .await
            .expect("allowed");
        switch_branch(&port, &root, "main", true)
            .await
            .expect("back");
        std::fs::write(repo.join("file.txt"), "content\n").expect("clean");
        delete_unchanged_branch(&port, &root, "feature", &head.unwrap_or_default())
            .await
            .expect("delete");
        let refs = fixture
            .command(&repo, &[])
            .args(["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .output()
            .expect("show-ref");
        assert!(!refs.status.success());
    }

    #[tokio::test]
    async fn cleanup_deletes_the_direct_ref_not_a_symbolic_ref_at_the_same_oid() {
        let fixture = Fixture::new("g4-symbolic-cleanup");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        fixture.git(&repo, &["branch", "feature"]);
        fixture.git(
            &repo,
            &["symbolic-ref", "refs/heads/feature", "refs/heads/main"],
        );
        create_branch(&port, &root, "real", "HEAD")
            .await
            .expect("create");
        assert_eq!(
            delete_unchanged_branch(&port, &root, "feature", &head)
                .await
                .expect_err("symbolic")
                .code,
            GitErrorCode::InvalidRef
        );
        delete_unchanged_branch(&port, &root, "real", &head)
            .await
            .expect("delete real");
        let main = fixture
            .command(&repo, &[])
            .args(["show-ref", "--verify", "--quiet", "refs/heads/main"])
            .output()
            .expect("main");
        assert!(main.status.success());
    }

    #[tokio::test]
    async fn cleanup_refuses_a_branch_still_checked_out_in_another_worktree() {
        let fixture = Fixture::new("g4-cleanup-worktree");
        let repo = fixture.repository("repo");
        let side = repo.parent().expect("parent").join("side");
        create_branch(
            &ProcessCommands { fixture: &fixture },
            &repo.to_string_lossy(),
            "feature",
            "HEAD",
        )
        .await
        .expect("create");
        fixture.git(
            &repo,
            &["worktree", "add", side.to_str().expect("path"), "feature"],
        );
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "feature"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        assert_eq!(
            delete_unchanged_branch(&port, &repo.to_string_lossy(), "feature", &head)
                .await
                .expect_err("checked out elsewhere")
                .code,
            GitErrorCode::RestoreCollision
        );
    }

    #[tokio::test]
    async fn a_branch_is_blocked_by_its_own_folder_and_by_a_branch_under_it() {
        let fixture = Fixture::new("g4a-ref-conflict");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_no_ref_conflict(&port, &root, "feature")
            .await
            .expect("free");
        fixture.git(&repo, &["branch", "ace"]);
        let error = assert_no_ref_conflict(&port, &root, "ace/1f2e")
            .await
            .expect_err("parent exists");
        assert_eq!(error.code, GitErrorCode::RefConflict);
        fixture.git(&repo, &["branch", "group/topic"]);
        let error = assert_no_ref_conflict(&port, &root, "group")
            .await
            .expect_err("child exists");
        assert_eq!(error.code, GitErrorCode::RefConflict);
    }
}
