// SPDX-License-Identifier: Apache-2.0
//! Staging and unstaging (`source-control-ops.ts`'s `validateRepoPaths`, `stagePaths`,
//! `unstagePaths`, and `ace-private.ts`'s pathspec rules; G4a).
//!
//! Proof: `source-control-ops.process` and `client-actions.process` (stage/unstage, literal
//! pathspecs, ace's private entries, unborn HEAD), against real Git in temp repositories.

use std::collections::HashSet;
use std::path::Path;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::reads::{Command, CommandPort, checked};

/// The most paths one call may name.
pub const MAX_PATHS: usize = 1000;
/// Pathspec bytes one call may name: well inside every platform's argument limit.
pub const MAX_PATH_BYTES: usize = 256 * 1024;
/// The longest single repository path.
pub const MAX_PATH_LENGTH: usize = 4096;
/// ace's files service keeps uploads and Recently deleted entries under these names.
pub const ACE_PRIVATE_PATTERN: &str = ".ace-upload-*";

/// Whether a repository path is, or lies inside, one of ace's private entries.
pub fn is_ace_private(path: &str) -> bool {
    path.split('/').any(|part| part.starts_with(".ace-upload-"))
}

/// Pathspecs for an `add` of the person's paths: each literal, then excludes for ace's own
/// entries wherever they sit. Run without `GIT_LITERAL_PATHSPECS`.
pub fn person_pathspecs(paths: &[String]) -> Vec<String> {
    let mut specs: Vec<String> = paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .collect();
    specs.push(format!(":(exclude,glob)**/{ACE_PRIVATE_PATTERN}"));
    specs.push(format!(":(exclude,glob)**/{ACE_PRIVATE_PATTERN}/**"));
    specs
}

fn outside(message: &str) -> GitError {
    GitError::new(GitErrorCode::PathOutsideRepo, message)
}

fn invalid(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

/// Validates repository-relative paths so none escape `root`, target `.git`, or pass an empty or
/// NUL pathspec. A name like `..notes` is a file.
pub fn validate_repo_paths(root: &str, paths: &[String]) -> Result<Vec<String>, GitError> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err(invalid(format!("Name between 1 and {MAX_PATHS} paths")));
    }
    let mut total_bytes = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    let mut valid = Vec::new();
    for raw in paths {
        if raw.is_empty() || raw.encode_utf16().count() > MAX_PATH_LENGTH || raw.contains('\0') {
            return Err(outside("Path is invalid or contains NUL bytes"));
        }
        let drive_root = cfg!(windows)
            && raw.len() >= 2
            && raw.as_bytes()[0].is_ascii_alphabetic()
            && raw.as_bytes()[1] == b':';
        if raw.starts_with('/')
            || raw.starts_with('\\')
            || drive_root
            || Path::new(raw).is_absolute()
        {
            return Err(outside("Absolute paths are not allowed"));
        }
        let segments: Vec<&str> = raw.split(['/', '\\']).collect();
        if segments.contains(&"..")
            || segments
                .first()
                .is_some_and(|segment| segment.eq_ignore_ascii_case(".git"))
            || segments
                .iter()
                .any(|segment| segment.eq_ignore_ascii_case(".git"))
            || raw == "."
        {
            return Err(outside("Path escapes the repository or targets .git"));
        }
        let target = paths::resolve(root, raw);
        if !paths::within(root, &target) || target == paths::normalise(Path::new(root)) {
            return Err(outside("Path escapes the repository root"));
        }
        total_bytes += raw.len() + 1;
        if total_bytes > MAX_PATH_BYTES {
            return Err(invalid("Total pathspec length exceeds limit"));
        }
        if seen.insert(raw.clone()) {
            valid.push(raw.clone());
        }
    }
    Ok(valid)
}

fn add_command(root: &str, paths: &[String]) -> Command {
    let mut input = String::new();
    for path in paths {
        input.push_str(path);
        input.push('\0');
    }
    Command::new(
        root,
        &[
            "add",
            "--all",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
    )
    .with_input(input.as_bytes())
    .writing()
    .with_capture_bytes(65_536)
}

/// Stage the named paths, or every change in the checkout when none are named.
pub async fn stage_paths(
    port: &dyn CommandPort,
    root: &str,
    paths: Option<&[String]>,
) -> Result<(), GitError> {
    let paths = match paths {
        Some(paths) => Some(validate_repo_paths(root, paths)?),
        None => None,
    };
    let specs = person_pathspecs(&paths.unwrap_or_else(|| vec![".".to_owned()]));
    checked(port, add_command(root, &specs)).await?;
    Ok(())
}

/// Unstage the named paths, or every staged change when none are named. Always path-limited: a
/// reset without paths would move `ORIG_HEAD`, a merge's or rebase's recovery pointer.
pub async fn unstage_paths(
    port: &dyn CommandPort,
    root: &str,
    paths: Option<&[String]>,
) -> Result<(), GitError> {
    let requested = match paths {
        Some(paths) => Some(validate_repo_paths(root, paths)?),
        None => None,
    };
    let state = crate::reads::status::state(port, root, &[]).await?;
    let paths = match requested {
        Some(paths) => paths,
        None => {
            let mut seen: HashSet<String> = HashSet::new();
            let mut all = Vec::new();
            for entry in &state.status.staged {
                for path in std::iter::once(&entry.path).chain(entry.old_path.iter()) {
                    if seen.insert(path.clone()) {
                        all.push(path.clone());
                    }
                }
            }
            all
        }
    };
    if paths.is_empty() {
        return Ok(());
    }
    let mut input = String::new();
    for path in &paths {
        input.push_str(path);
        input.push('\0');
    }
    let args: &[&str] = if state.branch.head.is_none() {
        &[
            "rm",
            "--cached",
            "-r",
            "-q",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]
    } else {
        &[
            "reset",
            "-q",
            "HEAD",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]
    };
    checked(
        port,
        Command::new(root, args)
            .with_input(input.as_bytes())
            .writing()
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")])
            .with_capture_bytes(65_536),
    )
    .await?;
    Ok(())
}

/// `maxPathBytes` as the commit's own pathspec limit.
pub fn within_commit_path_bytes(paths: &[String]) -> bool {
    paths.iter().map(|path| path.len() + 1).sum::<usize>() <= MAX_PATH_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[test]
    fn paths_that_escape_or_target_git_are_path_outside_repo() {
        for path in [
            "/abs",
            "\\rooted",
            "a/../b",
            "..",
            ".git/config",
            "nested/.git/x",
            ".",
            "",
            "nul\0path",
        ] {
            let error = validate_repo_paths("/repo", &[path.to_owned()]).expect_err(path);
            assert_eq!(error.code, GitErrorCode::PathOutsideRepo, "{path:?}");
        }
        // `..notes` is a file, not a climb out, and a leading dot is fine.
        assert_eq!(
            validate_repo_paths("/repo", &["..notes".to_owned(), ".hidden".to_owned()])
                .expect("valid"),
            vec!["..notes".to_owned(), ".hidden".to_owned()]
        );
        assert_eq!(
            validate_repo_paths("/repo", &["a".to_owned(), "a".to_owned()]).expect("dedupe"),
            vec!["a".to_owned()]
        );
        assert_eq!(
            validate_repo_paths("/repo", &[]).expect_err("empty").code,
            GitErrorCode::InvalidArgument
        );
    }

    #[test]
    fn ace_private_entries_are_recognised_and_excluded_from_every_add() {
        assert!(is_ace_private(".ace-upload-123/file"));
        assert!(is_ace_private("dir/.ace-upload-x"));
        assert!(!is_ace_private("uploads/file"));
        assert_eq!(
            person_pathspecs(&["src".to_owned()]),
            vec![
                ":(literal)src".to_owned(),
                ":(exclude,glob)**/.ace-upload-*".to_owned(),
                ":(exclude,glob)**/.ace-upload-*/**".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn stage_and_unstage_name_their_paths_literally_and_unborn_head_uses_rm_cached() {
        let fixture = Fixture::new("g4a-stage");
        std::fs::create_dir_all(fixture.root.join("repo")).expect("dir");
        let repo = fixture.root.join("repo");
        fixture.git(&repo, &["init", "--quiet"]);
        std::fs::write(repo.join("*.txt"), "literal\n").expect("star");
        std::fs::write(repo.join("plain.txt"), "plain\n").expect("plain");
        std::fs::create_dir_all(repo.join(".ace-upload-1")).expect("upload dir");
        std::fs::write(repo.join(".ace-upload-1/file"), "private\n").expect("upload");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        stage_paths(&port, &root, None).await.expect("stage all");
        let staged = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("state");
        let paths: Vec<&str> = staged
            .status
            .staged
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert!(paths.contains(&"*.txt"));
        assert!(paths.contains(&"plain.txt"));
        assert!(
            !paths.iter().any(|path| path.starts_with(".ace-upload-")),
            "{paths:?}"
        );
        // Unstage one literal path; the other stays.
        unstage_paths(&port, &root, Some(&["*.txt".to_owned()]))
            .await
            .expect("unstage");
        let staged = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("state");
        assert_eq!(staged.status.staged.len(), 1);
        assert_eq!(staged.status.staged[0].path, "plain.txt");
        // Unborn HEAD: unstage everything uses `rm --cached`.
        unstage_paths(&port, &root, None)
            .await
            .expect("unstage all");
        let staged = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("state");
        assert!(staged.status.staged.is_empty());
    }

    #[tokio::test]
    async fn committing_and_staging_leave_deleted_paths_of_renames_alone() {
        let fixture = Fixture::new("g4a-rename");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["mv", "file.txt", "renamed.txt"]);
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        let state = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("state");
        assert_eq!(state.status.staged.len(), 1);
        assert!(state.status.staged[0].old_path.is_some());
        unstage_paths(&port, &root, None).await.expect("unstage");
        let state = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("state");
        assert!(state.status.staged.is_empty());
        // The old name is gone from the worktree and the new one is untracked.
        assert_eq!(state.status.untracked, vec!["renamed.txt".to_owned()]);
    }
}
