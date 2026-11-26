// SPDX-License-Identifier: Apache-2.0
//! Merge writes (`merge-conflicts.ts`, G4): start, abort, resolve a file, take a side and
//! commit the merge, each refusing anything that would mix the person's work into a merge.
//!
//! Proof: `merge-conflicts.process` and `integration.process`, against real Git in temp
//! repositories. A long write takes the surface's long-write deadline when wired; these calls
//! keep the exact arguments and environment.

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::core::decode::{hash_schema, nul};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::reads::{Command, CommandPort, checked, text_output};

/// `maxConflictFileBytes`: the largest resolution ace writes.
pub const MAX_CONFLICT_FILE_BYTES: usize = 131_072;
/// `maxCommitMessageLength`.
pub const MAX_COMMIT_MESSAGE_LENGTH: usize = 65_536;

/// How a merge that started ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeStart {
    Conflicts,
    Merged,
    UpToDate,
}

impl MergeStart {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conflicts => "conflicts",
            Self::Merged => "merged",
            Self::UpToDate => "up_to_date",
        }
    }
}

fn commit_id(value: &str) -> Result<String, GitError> {
    hash_schema(value)
        .ok_or_else(|| GitError::new(GitErrorCode::InvalidArgument, "Invalid commit id"))
}

fn invalid(message: &str) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

/// `git rev-parse --verify --quiet MERGE_HEAD^{commit}` is the merge state.
pub async fn merging(port: &dyn CommandPort, root: &str) -> Result<bool, GitError> {
    let head = checked(
        port,
        Command::new(
            root,
            &["rev-parse", "--verify", "--quiet", "MERGE_HEAD^{commit}"],
        )
        .allowing_failure(),
    )
    .await?;
    Ok(head.exit_code == 0)
}

/// Merge `revision` into the checkout and stop before committing, conflicts or not.
pub async fn start_merge(
    port: &dyn CommandPort,
    root: &str,
    revision: &str,
    expected_head: &str,
    message: &str,
) -> Result<MergeStart, GitError> {
    let target = commit_id(revision)?;
    let expected = commit_id(expected_head)?;
    let text = message.trim();
    if text.is_empty() || text.encode_utf16().count() > MAX_COMMIT_MESSAGE_LENGTH {
        return Err(invalid("A merge message is required"));
    }
    if merging(port, root).await? {
        return Err(GitError::new(
            GitErrorCode::Conflicts,
            "A merge is already in progress",
        ));
    }
    let state = crate::reads::status::state(port, root, &[]).await?;
    if state.branch.head.as_deref() != Some(expected.as_str()) {
        return Err(GitError::new(
            GitErrorCode::HeadMoved,
            "HEAD moved; refresh first",
        ));
    }
    if !state.status.conflicted.is_empty()
        || !state.status.staged.is_empty()
        || !state.status.unstaged.is_empty()
    {
        return Err(GitError::new(
            GitErrorCode::DirtyWorktree,
            "Commit or discard the checkout's changes first",
        ));
    }
    let known = checked(
        port,
        Command::new(
            root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &format!("{target}^{{commit}}"),
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if known.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "The base isn't in this checkout",
        ));
    }
    let merged = checked(
        port,
        Command::new(
            root,
            &[
                "-c",
                "merge.conflictStyle=diff3",
                "-c",
                "rerere.enabled=false",
                "merge",
                "--no-commit",
                "--no-ff",
                "--no-edit",
                "-m",
                text,
                "--end-of-options",
                &target,
            ],
        )
        .writing()
        .allowing_failure()
        .with_capture_bytes(65_536)
        .with_env(&[("GIT_MERGE_AUTOEDIT", "no"), ("GIT_EDITOR", "true")]),
    )
    .await?;
    if merging(port, root).await? {
        let status = crate::reads::status::status(port, root, &[]).await?;
        return Ok(if status.conflicted.is_empty() {
            MergeStart::Merged
        } else {
            MergeStart::Conflicts
        });
    }
    if merged.exit_code == 0 {
        return Ok(MergeStart::UpToDate);
    }
    // Git refused before touching anything: an untracked file is where the merge writes one.
    Err(GitError::new(
        GitErrorCode::DirtyWorktree,
        "Git couldn't start the merge: move untracked files it would overwrite",
    ))
}

/// `git merge --abort`: the checkout goes back to HEAD as it was before the merge.
pub async fn abort_merge(port: &dyn CommandPort, root: &str) -> Result<(), GitError> {
    if !merging(port, root).await? {
        return Err(invalid("No merge is in progress"));
    }
    checked(port, Command::new(root, &["merge", "--abort"]).writing()).await?;
    Ok(())
}

/// `git ls-files -u`'s stages for each unmerged path.
pub async fn unmerged_paths(
    port: &dyn CommandPort,
    root: &str,
    only: Option<&str>,
) -> Result<Vec<(String, [bool; 3])>, GitError> {
    let mut args: Vec<String> = vec![
        "ls-files".to_owned(),
        "--unmerged".to_owned(),
        "-z".to_owned(),
    ];
    if let Some(only) = only {
        args.push("--".to_owned());
        args.push(only.to_owned());
    }
    let mut command = Command::owned(root, args).with_capture_bytes(8 * 1_048_576);
    if only.is_some() {
        command = command.with_env(&[("GIT_LITERAL_PATHSPECS", "1")]);
    }
    let listed = checked(port, command).await?;
    if listed.truncated {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            "Too many conflicted files",
        ));
    }
    let mut paths: Vec<(String, [bool; 3])> = Vec::new();
    for record in nul(&listed.stdout)? {
        let Some(tab) = record.find('\t') else {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable unmerged entry",
            ));
        };
        let header: Vec<&str> = record[..tab].split(' ').collect();
        let [mode, sha, stage] = match header.as_slice() {
            [mode, sha, stage] => [*mode, *sha, *stage],
            _ => {
                return Err(GitError::new(
                    GitErrorCode::MalformedOutput,
                    "Unreadable unmerged entry",
                ));
            }
        };
        if mode.is_empty()
            || !mode.bytes().all(|byte| byte.is_ascii_digit())
            || sha.is_empty()
            || !sha.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(stage, "1" | "2" | "3")
        {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable unmerged entry",
            ));
        }
        let path = &record[tab + 1..];
        if path.is_empty() {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable unmerged entry",
            ));
        }
        let index = match paths.iter().position(|(known, _)| known == path) {
            Some(index) => index,
            None => {
                paths.push((path.to_owned(), [false, false, false]));
                paths.len() - 1
            }
        };
        if let Some((_, stages)) = paths.get_mut(index) {
            stages[match stage {
                "1" => 0,
                "2" => 1,
                _ => 2,
            }] = true;
        }
    }
    Ok(paths)
}

async fn assert_unmerged(
    port: &dyn CommandPort,
    root: &str,
    name: &str,
) -> Result<[bool; 3], GitError> {
    if !merging(port, root).await? {
        return Err(invalid("No merge is in progress"));
    }
    unmerged_paths(port, root, Some(name))
        .await?
        .into_iter()
        .find(|(path, _)| path == name)
        .map(|(_, stages)| stages)
        .ok_or_else(|| invalid(&format!("{name} has no conflict to resolve")))
}

/// The path inside the checkout when it's a regular file there (no symlink on the way out).
fn regular_file(root: &str, name: &str) -> Option<String> {
    let root = paths::canonical(root).unwrap_or_else(|_| root.to_owned());
    let file = Path::new(&root).join(name);
    let parent = file.parent()?;
    let real_parent = paths::canonical(&parent.to_string_lossy()).ok()?;
    if !paths::within(&root, &real_parent) {
        return None;
    }
    std::fs::symlink_metadata(&file)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| file.to_string_lossy().into_owned())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn stage(port: &dyn CommandPort, root: &str, args: &[&str]) -> Result<(), GitError> {
    checked(
        port,
        Command::new(root, args)
            .writing()
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
    )
    .await?;
    Ok(())
}

/// Write an unmerged file's resolved text, unless it changed since `revision` was read.
pub async fn write_resolution(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    content: &str,
    revision: &str,
) -> Result<bool, GitError> {
    if path.is_empty() || path.chars().count() > 4096 || path.contains('\0') {
        return Err(invalid("Invalid repository path"));
    }
    if revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("Invalid revision"));
    }
    if content.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(invalid("The resolution is too large to write here"));
    }
    assert_unmerged(port, root, path).await?;
    let Some(file) = regular_file(root, path) else {
        return Err(GitError::new(
            GitErrorCode::HeadMoved,
            format!("{path} changed since it was read; refresh first"),
        ));
    };
    let bytes = std::fs::read(&file).map_err(|error| GitError::from_io(&error))?;
    if digest(&bytes) != revision {
        return Err(GitError::new(
            GitErrorCode::HeadMoved,
            format!("{path} changed since it was read; refresh first"),
        ));
    }
    std::fs::write(&file, content).map_err(|error| GitError::from_io(&error))?;
    if crate::reads::conflicts::has_conflict_hunks(content) {
        return Ok(false);
    }
    stage(port, root, &["add", "--", path]).await?;
    Ok(true)
}

/// Resolve a path to one side's whole version, or its deletion when that side deleted it.
pub async fn take_side(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    side: &str,
) -> Result<(), GitError> {
    if !matches!(side, "ours" | "theirs") {
        return Err(invalid("A side is ours or theirs"));
    }
    let stages = assert_unmerged(port, root, path).await?;
    let present = if side == "ours" { stages[1] } else { stages[2] };
    if !present {
        return stage(port, root, &["rm", "--quiet", "--force", "--", path]).await;
    }
    stage(port, root, &["checkout", &format!("--{side}"), "--", path]).await?;
    stage(port, root, &["add", "--", path]).await
}

/// Commit the merge in progress with exactly what is staged and the message `startMerge` gave.
pub async fn commit_merge(
    port: &dyn CommandPort,
    root: &str,
    expected_head: &str,
) -> Result<String, GitError> {
    let expected = commit_id(expected_head)?;
    let state = crate::reads::status::state(port, root, &[]).await?;
    if state.branch.head.as_deref() != Some(expected.as_str()) {
        return Err(GitError::new(
            GitErrorCode::HeadMoved,
            "HEAD moved; refresh first",
        ));
    }
    if !merging(port, root).await? {
        return Err(invalid("No merge is in progress"));
    }
    if !state.status.conflicted.is_empty() {
        return Err(GitError::new(
            GitErrorCode::Conflicts,
            "Resolve every conflicted file first",
        ));
    }
    checked(
        port,
        Command::new(root, &["commit", "--no-edit", "--cleanup=strip"])
            .writing()
            .with_capture_bytes(65_536)
            .with_env(&[("GIT_TRACE2_EVENT", "1")]),
    )
    .await?;
    crate::reads::info::head(port, root)
        .await?
        .ok_or_else(|| invalid("The merge left no commit"))
}

/// A commit's subject from its message, for callers that log what a merge wrote.
pub fn subject(message: &str) -> String {
    message.lines().next().unwrap_or_default().trim().to_owned()
}

/// The message a merge prepared, from the repository's own MERGE_MSG.
pub async fn merge_message(port: &dyn CommandPort, root: &str) -> Result<String, GitError> {
    let message = checked(
        port,
        Command::new(root, &["rev-parse", "--git-path", "MERGE_MSG"]),
    )
    .await?;
    let path = text_output(&message.stdout)?;
    let path = if Path::new(&path).is_absolute() {
        path
    } else {
        paths::resolve(root, &path)
    };
    std::fs::read_to_string(path).map_err(|error| GitError::from_io(&error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn conflicting(fixture: &Fixture, repo: &Path) -> String {
        fixture.git(repo, &["checkout", "--quiet", "-b", "other"]);
        std::fs::write(repo.join("file.txt"), "theirs line\n").expect("theirs");
        fixture.git(repo, &["commit", "--quiet", "-am", "theirs"]);
        fixture.git(repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join("file.txt"), "ours line\n").expect("ours");
        fixture.git(repo, &["commit", "--quiet", "-am", "ours"]);
        String::from_utf8_lossy(&fixture.git(repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned()
    }

    #[tokio::test]
    async fn a_merge_starts_with_diff3_markers_and_aborts_back_to_head() {
        let fixture = Fixture::new("g4-merge");
        let repo = fixture.repository("repo");
        let head = conflicting(&fixture, &repo);
        let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "other"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            start_merge(&port, &root, &other, &head, "merge other")
                .await
                .expect("start"),
            MergeStart::Conflicts
        );
        assert!(merging(&port, &root).await.expect("merging"));
        let conflicts = crate::reads::conflicts::read_conflicts(&port, &root)
            .await
            .expect("conflicts");
        assert_eq!(conflicts.files.len(), 1);
        abort_merge(&port, &root).await.expect("abort");
        assert!(!merging(&port, &root).await.expect("aborted"));
        assert_eq!(
            crate::reads::info::head(&port, &root).await.expect("head"),
            Some(head)
        );
    }

    #[tokio::test]
    async fn a_resolution_that_keeps_hunks_stays_unstaged_and_a_stale_one_is_refused() {
        let fixture = Fixture::new("g4-resolution");
        let repo = fixture.repository("repo");
        let head = conflicting(&fixture, &repo);
        let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "other"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        start_merge(&port, &root, &other, &head, "merge")
            .await
            .expect("start");
        let bytes = std::fs::read(repo.join("file.txt")).expect("conflict file");
        let revision = digest(&bytes);
        // A stale revision is refused.
        assert_eq!(
            write_resolution(&port, &root, "file.txt", "resolved\n", &"0".repeat(64),)
                .await
                .expect_err("stale")
                .code,
            GitErrorCode::HeadMoved
        );
        // A resolution that still holds a hunk is written but not staged.
        let text = crate::reads::conflicts::read_conflicts(&port, &root)
            .await
            .expect("conflicts");
        let crate::reads::conflicts::ConflictContent::Text { segments, .. } =
            &text.files[0].content
        else {
            panic!("text");
        };
        let hunk = segments
            .iter()
            .find_map(|segment| match segment {
                crate::reads::conflicts::ConflictSegment::Conflict {
                    ours,
                    theirs,
                    markers,
                    ..
                } => Some(format!(
                    "{}{}{}{}{}",
                    markers.ours, ours, markers.separator, theirs, markers.theirs
                )),
                _ => None,
            })
            .expect("a hunk");
        assert!(
            !write_resolution(&port, &root, "file.txt", &hunk, &revision)
                .await
                .expect("write")
        );
        // A clean resolution stages the file.
        let clean = "resolved\n";
        let bytes = std::fs::read(repo.join("file.txt")).expect("file");
        assert!(
            write_resolution(&port, &root, "file.txt", clean, &digest(&bytes))
                .await
                .expect("write")
        );
        let status = crate::reads::status::status(&port, &root, &[])
            .await
            .expect("status");
        assert!(status.conflicted.is_empty());
        assert!(status.staged.iter().any(|entry| entry.path == "file.txt"));
    }

    #[tokio::test]
    async fn taking_a_side_and_committing_the_merge_clears_the_merge_state() {
        let fixture = Fixture::new("g4-take");
        let repo = fixture.repository("repo");
        let head = conflicting(&fixture, &repo);
        let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "other"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        start_merge(&port, &root, &other, &head, "merge side")
            .await
            .expect("start");
        take_side(&port, &root, "file.txt", "theirs")
            .await
            .expect("take");
        let status = crate::reads::status::status(&port, &root, &[])
            .await
            .expect("status");
        assert!(status.conflicted.is_empty());
        let merge_commit = commit_merge(&port, &root, &head)
            .await
            .expect("commit merge");
        assert!(!merging(&port, &root).await.expect("done"));
        let parents = fixture.git(&repo, &["rev-list", "--parents", "-n", "1", &merge_commit]);
        assert_eq!(
            String::from_utf8_lossy(&parents).split_whitespace().count(),
            3
        );
    }

    #[tokio::test]
    async fn a_moved_head_a_dirty_checkout_and_a_second_merge_are_refused() {
        let fixture = Fixture::new("g4-merge-refusals");
        let repo = fixture.repository("repo");
        let head = conflicting(&fixture, &repo);
        let other = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "other"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_eq!(
            start_merge(&port, &root, &other, &"b".repeat(40), "merge")
                .await
                .expect_err("moved")
                .code,
            GitErrorCode::HeadMoved
        );
        std::fs::write(repo.join("file.txt"), "dirty\n").expect("dirty");
        assert_eq!(
            start_merge(&port, &root, &other, &head, "merge")
                .await
                .expect_err("dirty")
                .code,
            GitErrorCode::DirtyWorktree
        );
    }
}
