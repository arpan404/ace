// SPDX-License-Identifier: Apache-2.0
//! File history and one commit's patch (`packages/git/src/history.ts`, G3c): `git log --follow`
//! bounded by bytes and a work budget, and `diffCommit` against the first parent or the empty
//! tree, with the shallow-boundary refusal.
//!
//! Proof: `history.process` (log entries, renames, the limit and byte cap, commit patches,
//! unknown commits, bare roots), against real Git in temp repositories.

use std::path::Path;

use serde::Serialize;

use crate::core::decode::{hash, path_schema};
use crate::core::error::{GitError, GitErrorCode};
use crate::parse::history::{GitLogEntry, LOG_FORMAT, parse_file_log};
use crate::reads::{Command, CommandPort, checked, text_output};

/// `gitLogMaxLimit`: the most commits one read lists.
pub const GIT_LOG_MAX_LIMIT: usize = 200;
/// `gitLogMaxBytes`: the byte cap for one read.
pub const GIT_LOG_MAX_BYTES: usize = 1024 * 1024;
/// How long one history read may make Git work before it is stopped.
pub const HISTORY_BUDGET_MS: u64 = 10_000;

const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// One file-log read's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLogResult {
    pub entries: Vec<GitLogEntry>,
    /// Why the list ends before the file's first commit: `limit` or `budget`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
    pub head: Option<String>,
}

/// One commit patch's answer (`DiffResult` with no entries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitDiffResult {
    pub entries: Vec<crate::parse::diff::DiffEntry>,
    pub patch: String,
    pub truncated: bool,
}

fn invalid(message: String) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

fn validate_path(path: &str) -> Result<String, GitError> {
    if path.contains('\\') {
        return Err(invalid(format!("Invalid repository path: {path}")));
    }
    path_schema(path).ok_or_else(|| invalid(format!("Invalid repository path: {path}")))
}

fn validate_commit(commit: &str) -> Result<String, GitError> {
    hash(commit).map_err(|_| {
        GitError::new(
            GitErrorCode::InvalidRef,
            format!("Invalid commit id: {commit}"),
        )
    })
}

/// A file's newest commits following renames, in one walk bounded by bytes and work.
pub async fn file_log(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    limit: usize,
    max_bytes: usize,
    budget_ms: u64,
) -> Result<FileLogResult, GitError> {
    let path = validate_path(path)?;
    if !(1..=GIT_LOG_MAX_LIMIT).contains(&limit) {
        return Err(invalid(format!(
            "limit must be between 1 and {GIT_LOG_MAX_LIMIT}"
        )));
    }
    if max_bytes < 1 {
        return Err(invalid("maxBytes must be a positive integer".to_owned()));
    }
    let Some(head) = crate::reads::info::head(port, root).await? else {
        return Ok(FileLogResult {
            entries: Vec::new(),
            stopped: None,
            head: None,
        });
    };
    let output = checked(
        port,
        Command::owned(
            root,
            vec![
                "-c".to_owned(),
                "core.quotePath=false".to_owned(),
                "log".to_owned(),
                "--follow".to_owned(),
                "--name-status".to_owned(),
                "-z".to_owned(),
                format!("--max-count={}", limit + 1),
                format!("--format={LOG_FORMAT}"),
                head.clone(),
                "--".to_owned(),
                format!(":(literal){path}"),
            ],
        )
        .with_capture_bytes(max_bytes)
        .stopping_at_capture()
        .stopping_after(budget_ms),
    )
    .await?;
    let parsed = parse_file_log(&output.stdout, &path, output.truncated);
    let total = parsed.entries.len();
    let mut entries = parsed.entries;
    entries.truncate(limit);
    // A work budget that fires is the output's own stop reason; everything else that ends the
    // list early ended it at the count or the byte cap.
    let stopped = if output.stopped.as_deref() == Some("budget") {
        Some("budget".to_owned())
    } else if total > limit || parsed.incomplete {
        Some("limit".to_owned())
    } else {
        None
    };
    Ok(FileLogResult {
        entries,
        stopped,
        head: Some(head),
    })
}

/// One commit's patch for `paths`, against its first parent or the empty tree.
#[allow(clippy::too_many_arguments)]
pub async fn diff_commit(
    port: &dyn CommandPort,
    root: &str,
    commit: &str,
    paths: &[String],
    max_patch_bytes: usize,
    budget_ms: u64,
    is_windows: bool,
) -> Result<CommitDiffResult, GitError> {
    let commit = validate_commit(commit)?;
    let mut validated = Vec::with_capacity(paths.len());
    for path in paths {
        validated.push(validate_path(path)?);
    }
    let sha = crate::reads::diff::resolve_commit(port, root, &commit).await?;
    let parents = parents_of(port, root, &sha).await?;
    if parents.is_empty() && shallow_boundary(port, root, &sha).await? {
        return Err(GitError::new(
            GitErrorCode::ShallowParent,
            "The parent commit isn't in this clone",
        ));
    }
    let from = parents.first().cloned().unwrap_or_else(|| {
        if sha.len() == 64 {
            EMPTY_TREE_SHA256.to_owned()
        } else {
            EMPTY_TREE_SHA1.to_owned()
        }
    });
    let mut args = crate::reads::diff::diff_args(is_windows);
    for arg in ["--patch", "--unified=3", "--inter-hunk-context=0"] {
        args.push(arg.to_owned());
    }
    args.push(from);
    args.push(sha);
    args.push("--".to_owned());
    args.extend(validated.iter().map(|path| format!(":(literal){path}")));
    let patch = checked(
        port,
        Command::owned(root, args)
            .with_capture_bytes(max_patch_bytes)
            .stopping_at_capture()
            .stopping_after(budget_ms),
    )
    .await?;
    Ok(CommitDiffResult {
        entries: Vec::new(),
        patch: crate::core::cli::patch_output(&patch.stdout, patch.truncated),
        truncated: patch.truncated,
    })
}

/// A commit's parents (none for a root commit).
async fn parents_of(
    port: &dyn CommandPort,
    root: &str,
    commit: &str,
) -> Result<Vec<String>, GitError> {
    let output = checked(
        port,
        Command::new(root, &["rev-list", "--parents", "-n", "1", commit])
            .with_capture_bytes(64 * 1024),
    )
    .await?;
    let text = text_output(&output.stdout)?;
    Ok(text
        .split(' ')
        .skip(1)
        .filter(|parent| !parent.is_empty())
        .map(str::to_owned)
        .collect())
}

/// Whether this is a shallow clone and `sha` is one of its boundary commits (parents hidden).
async fn shallow_boundary(port: &dyn CommandPort, root: &str, sha: &str) -> Result<bool, GitError> {
    let shallow = checked(
        port,
        Command::new(root, &["rev-parse", "--is-shallow-repository"]).with_capture_bytes(64 * 1024),
    )
    .await?;
    if text_output(&shallow.stdout)? != "true" {
        return Ok(false);
    }
    let file = checked(
        port,
        Command::new(root, &["rev-parse", "--git-path", "shallow"]).with_capture_bytes(64 * 1024),
    )
    .await?;
    let file = text_output(&file.stdout)?;
    let file = if Path::new(&file).is_absolute() {
        file
    } else {
        Path::new(root).join(file).to_string_lossy().into_owned()
    };
    let listed = std::fs::read(&file)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    Ok(listed.split('\n').any(|line| line.trim() == sha))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn commit_all(fixture: &Fixture, repo: &Path, message: &str) {
        fixture.git(repo, &["add", "--all"]);
        fixture.git(repo, &["commit", "--quiet", "-m", message]);
    }

    // `history.process`: a file's newest commits follow a rename and say why they stopped.
    #[tokio::test]
    async fn a_file_log_lists_newest_first_follows_the_rename_and_honours_its_limit() {
        let fixture = Fixture::new("g3c-log");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("file.txt"), "one\n").expect("one");
        commit_all(&fixture, &repo, "first");
        std::fs::write(repo.join("file.txt"), "two\n").expect("two");
        commit_all(&fixture, &repo, "second");
        // A pure rename, so Git's detection does not depend on a similarity threshold.
        fixture.git(&repo, &["mv", "file.txt", "renamed.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "rename"]);
        std::fs::write(repo.join("renamed.txt"), "three\n").expect("three");
        commit_all(&fixture, &repo, "edit");
        let port = ProcessCommands { fixture: &fixture };
        let all = file_log(
            &port,
            &repo.to_string_lossy(),
            "renamed.txt",
            200,
            GIT_LOG_MAX_BYTES,
            HISTORY_BUDGET_MS,
        )
        .await
        .expect("log");
        assert_eq!(all.entries.len(), 5);
        assert_eq!(all.entries[0].subject, "edit");
        assert_eq!(all.entries[1].subject, "rename");
        assert_eq!(all.entries[1].path, "renamed.txt");
        assert_eq!(all.entries[1].previous_path.as_deref(), Some("file.txt"));
        assert_eq!(all.entries[0].short_sha.len(), 7);
        assert!(all.entries[0].authored_at > 0);
        assert_eq!(all.stopped, None);
        assert!(all.head.is_some());
        let capped = file_log(
            &port,
            &repo.to_string_lossy(),
            "renamed.txt",
            2,
            GIT_LOG_MAX_BYTES,
            HISTORY_BUDGET_MS,
        )
        .await
        .expect("capped");
        assert_eq!(capped.entries.len(), 2);
        assert_eq!(capped.stopped.as_deref(), Some("limit"));
        // The byte cap stops the walk and says so.
        let small = file_log(
            &port,
            &repo.to_string_lossy(),
            "renamed.txt",
            200,
            120,
            HISTORY_BUDGET_MS,
        )
        .await
        .expect("byte cap");
        assert!(small.stopped.is_some());
    }

    #[tokio::test]
    async fn an_unborn_branch_and_an_invalid_path_are_answered_without_a_walk() {
        let fixture = Fixture::new("g3c-log-empty");
        std::fs::create_dir_all(fixture.root.join("empty")).expect("dir");
        let empty = fixture.root.join("empty");
        fixture.git(&empty, &["init", "--quiet"]);
        let port = ProcessCommands { fixture: &fixture };
        assert_eq!(
            file_log(
                &port,
                &empty.to_string_lossy(),
                "file.txt",
                10,
                GIT_LOG_MAX_BYTES,
                HISTORY_BUDGET_MS
            )
            .await
            .expect("unborn"),
            FileLogResult {
                entries: Vec::new(),
                stopped: None,
                head: None,
            }
        );
        for path in ["/absolute", "..", "a\\b", ".git/config", ""] {
            let error = file_log(
                &port,
                &empty.to_string_lossy(),
                path,
                10,
                GIT_LOG_MAX_BYTES,
                HISTORY_BUDGET_MS,
            )
            .await
            .expect_err(path);
            assert_eq!(error.code, GitErrorCode::InvalidArgument, "{path}");
        }
        assert_eq!(
            file_log(
                &port,
                &empty.to_string_lossy(),
                "file.txt",
                0,
                GIT_LOG_MAX_BYTES,
                HISTORY_BUDGET_MS
            )
            .await
            .expect_err("limit")
            .code,
            GitErrorCode::InvalidArgument
        );
    }

    // `history.process`: a commit's patch against its first parent, and the empty tree at a root.
    #[tokio::test]
    async fn a_commit_patch_is_against_the_first_parent_and_a_root_commit_against_the_empty_tree() {
        let fixture = Fixture::new("g3c-patch");
        let repo = fixture.repository("repo");
        let root_commit = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        std::fs::write(repo.join("file.txt"), "after\n").expect("edit");
        commit_all(&fixture, &repo, "change");
        let change = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let patch = diff_commit(
            &port,
            &repo.to_string_lossy(),
            &change,
            &[],
            1_000_000,
            HISTORY_BUDGET_MS,
            false,
        )
        .await
        .expect("patch");
        assert!(patch.patch.contains("-content\n+after"));
        assert!(!patch.truncated);
        assert!(patch.entries.is_empty());
        let root = diff_commit(
            &port,
            &repo.to_string_lossy(),
            &root_commit,
            &[],
            1_000_000,
            HISTORY_BUDGET_MS,
            false,
        )
        .await
        .expect("root");
        assert!(root.patch.contains("+content"));
        // The cap bounds the patch and never splits a character.
        let capped = diff_commit(
            &port,
            &repo.to_string_lossy(),
            &change,
            &[],
            4,
            HISTORY_BUDGET_MS,
            false,
        )
        .await
        .expect("capped");
        assert!(capped.truncated);
        assert!(capped.patch.len() <= 4);
        for commit in ["HEAD", "no-such-commit", "abc"] {
            let error = diff_commit(
                &port,
                &repo.to_string_lossy(),
                commit,
                &[],
                1_000_000,
                HISTORY_BUDGET_MS,
                false,
            )
            .await
            .expect_err(commit);
            assert_eq!(error.code, GitErrorCode::InvalidRef, "{commit}");
        }
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::core::spawn::BoxFuture;
    use crate::reads::test_support::ProcessCommands;
    use crate::reads::{Command, CommandOutput};

    /// A port that answers the log walk with a complete entry and the supervisor's budget stop.
    struct BudgetLog<'a> {
        inner: ProcessCommands<'a>,
        body: Vec<u8>,
    }

    impl crate::reads::CommandPort for BudgetLog<'_> {
        fn run_streaming<'a>(
            &'a self,
            command: Command,
            consume: &'a (dyn Fn(&[u8]) + Send + Sync),
        ) -> BoxFuture<'a, Result<CommandOutput, GitError>> {
            self.inner.run_streaming(command, consume)
        }

        fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            if command.args.iter().any(|arg| arg == "log") {
                let body = self.body.clone();
                return Box::pin(async move {
                    Ok(CommandOutput {
                        stdout: body,
                        stderr: String::new(),
                        exit_code: 0,
                        truncated: false,
                        stopped: Some("budget".to_owned()),
                    })
                });
            }
            self.inner.run(command)
        }
    }

    #[tokio::test]
    async fn a_budget_stop_is_reported_as_budget_not_as_the_count_limit() {
        let fixture = Fixture::new("g3c-budget");
        let repo = fixture.repository("repo");
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let body = format!("{head}\0Ana\0ana@example.invalid\01700000000\0subject\0\0");
        let port = BudgetLog {
            inner: ProcessCommands { fixture: &fixture },
            body: body.into_bytes(),
        };
        let result = file_log(
            &port,
            &repo.to_string_lossy(),
            "file.txt",
            200,
            GIT_LOG_MAX_BYTES,
            HISTORY_BUDGET_MS,
        )
        .await
        .expect("log");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.stopped.as_deref(), Some("budget"));
    }
}
