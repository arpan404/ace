//! One `git status` read (`Repository.state` in `packages/git/src/repository.ts`, G3a).
//!
//! Proof: `repository.process`, `changed-files-regressions.process`, `malformed.process` and
//! `failure-categories.process`.

use crate::core::error::GitError;
use crate::parse::status::{ParsedStatus, Status, parse_status};
use crate::reads::{Command, CommandPort, checked};

/// `Repository.state`'s command, exactly as the TypeScript runs it.
pub const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--ahead-behind",
    "--no-show-stash",
    "--untracked-files=all",
    "--renames",
    "--ignore-submodules=none",
];

/// Reads and parses one status. A held `directoryFd` stays on the TypeScript backend until the
/// supervisor can spawn in it (porting guide rule 5).
pub async fn state(
    port: &dyn CommandPort,
    root: &str,
    env: &[(&str, &str)],
) -> Result<ParsedStatus, GitError> {
    let command = Command::new(root, STATUS_ARGS).with_env(env);
    let output = checked(port, command).await?;
    parse_status(&output.stdout)
}

/// `Repository.status`: the four lists only.
pub async fn status(
    port: &dyn CommandPort,
    root: &str,
    env: &[(&str, &str)],
) -> Result<Status, GitError> {
    Ok(state(port, root, env).await?.status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::core::error::GitErrorCode;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn a_conflicted_file_stays_conflicted_in_its_own_list() {
        let fixture = Fixture::new("g3a-status-conflict");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["checkout", "--quiet", "-b", "other"]);
        std::fs::write(repo.join("file.txt"), "other\n").expect("other");
        fixture.git(&repo, &["commit", "--quiet", "-am", "other"]);
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join("file.txt"), "main\n").expect("main");
        fixture.git(&repo, &["commit", "--quiet", "-am", "main"]);
        let merge = fixture
            .command(&repo, &[])
            .args(["merge", "other"])
            .output()
            .expect("merge");
        assert!(!merge.status.success());
        let port = ProcessCommands { fixture: &fixture };
        let state = state(&port, &repo.to_string_lossy(), &[])
            .await
            .expect("status");
        assert_eq!(state.status.conflicted.len(), 1);
        assert_eq!(state.status.conflicted[0].path, "file.txt");
        assert_eq!(state.status.conflicted[0].index_status, "U");
        assert!(state.status.staged.is_empty());
        assert!(state.status.unstaged.is_empty());
    }

    #[tokio::test]
    async fn a_linked_worktree_nested_in_the_checkout_reads_as_one_untracked_directory() {
        let fixture = Fixture::new("g3a-status-linked");
        let repo = fixture.repository("repo");
        let nested = repo.join(".claude/worktrees/agent");
        fixture.git(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                &nested.to_string_lossy(),
                "-b",
                "agent",
            ],
        );
        let port = ProcessCommands { fixture: &fixture };
        let state = state(&port, &repo.to_string_lossy(), &[])
            .await
            .expect("status");
        assert_eq!(
            state.status.untracked,
            vec![".claude/worktrees/agent".to_owned()]
        );
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_is_a_typed_error_rather_than_an_empty_status() {
        let fixture = Fixture::new("g3a-status-missing");
        let port = ProcessCommands { fixture: &fixture };
        let error = state(&port, &fixture.root.to_string_lossy(), &[])
            .await
            .expect_err("not a repository");
        assert_eq!(error.code, GitErrorCode::GitFailed);
    }
}
