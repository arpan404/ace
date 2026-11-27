// SPDX-License-Identifier: Apache-2.0
//! Commits (`actions.ts`'s `commitChanges`, G4a): every change or only the named paths, with
//! the exact `add` and `commit` commands, their literal pathspecs and their 65,536-byte output
//! cap. `excludeAcePrivate` (the local `info/exclude` entry) waits for the checkpoint item,
//! which is the other caller that needs it; every add here excludes ace's entries by pathspec.
//!
//! Proof: `client-actions.process` and `source-control-ops.process` (commit all, paths only,
//! staged only, listed staging, head moved, conflicts, nothing to commit, private entries).

use crate::core::decode::hash_schema;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::reviewer::ecma_trim;
use crate::reads::{Command, CommandPort, checked};
use crate::writes::bind::{checkout_snapshot, long_writing, serial_turn};
use crate::writes::stage::{
    MAX_PATH_LENGTH, MAX_PATHS, is_ace_private, person_pathspecs, validate_repo_paths,
    within_commit_path_bytes,
};

/// The most a commit message may hold (a zod bound: code points).
pub const MAX_COMMIT_MESSAGE_LENGTH: usize = 65_536;

/// One commit request.
#[derive(Debug, Clone)]
pub struct CommitRequest {
    pub message: String,
    /// The HEAD the caller saw, or `None` on an unborn branch.
    pub expected_head: Option<String>,
    /// Repository-relative paths; `None` commits everything.
    pub paths: Option<Vec<String>>,
    /// Commit the index as it is: what the person staged, nothing more.
    pub staged_only: bool,
    /// Stage exactly these listed paths, then commit the index (`stageListed`).
    pub stage_listed: Option<Vec<String>>,
    /// The fingerprint the draft was written for; a mismatch refuses the commit.
    pub draft_fingerprint: Option<String>,
}

fn invalid(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

fn head_moved(message: &str) -> GitError {
    GitError::new(GitErrorCode::HeadMoved, message)
}

fn commit_paths(paths: &[String]) -> Result<Vec<String>, GitError> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err(invalid("Name between 1 and 1000 paths to commit"));
    }
    for path in paths {
        if path.is_empty() || path.chars().count() > MAX_PATH_LENGTH || path.contains('\0') {
            return Err(invalid("Name between 1 and 1000 paths to commit"));
        }
    }
    if !within_commit_path_bytes(paths) {
        return Err(invalid("Name between 1 and 1000 paths to commit"));
    }
    Ok(paths.to_vec())
}

fn add_all(root: &str, paths: &[String]) -> Command {
    let mut input = String::new();
    for path in person_pathspecs(paths) {
        input.push_str(&path);
        input.push('\0');
    }
    long_writing(Command::new(
        root,
        &[
            "add",
            "--all",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
    ))
    .with_input(input.as_bytes())
    .with_capture_bytes(65_536)
}

/// Commit the checkout: every change, or only `paths` (repository-relative, taken literally).
pub async fn commit_changes(
    port: &dyn CommandPort,
    root: &str,
    temp_directory: &str,
    request: &CommitRequest,
    is_windows: bool,
) -> Result<String, GitError> {
    let message = ecma_trim(&request.message);
    if message.is_empty() {
        return Err(invalid("A commit message is required"));
    }
    // The zod bound counts code points, so an astral character is one.
    if message.chars().count() > MAX_COMMIT_MESSAGE_LENGTH {
        return Err(invalid("The commit message is too long"));
    }
    if let Some(expected) = &request.expected_head
        && hash_schema(expected).is_none()
    {
        return Err(invalid("Invalid expected HEAD"));
    }
    let paths = match &request.paths {
        Some(paths) => Some(commit_paths(paths)?),
        None => None,
    };
    let listed = match &request.stage_listed {
        Some(listed) => Some(validate_repo_paths(root, listed)?),
        None => None,
    };
    let (_key, _serial) = serial_turn(root).await?;
    let info_head = crate::reads::info::head(port, root).await?;
    if info_head != request.expected_head {
        return Err(head_moved("HEAD changed; refresh before committing"));
    }
    let state = crate::reads::status::state(port, root, &[]).await?;
    // The status read may refresh the index; the snapshot is taken after it, so what a
    // terminal stages from here on is what the guards see.
    let observed = checkout_snapshot(port, root).await?;
    let mut staged = observed.clone();
    if !state.status.conflicted.is_empty() {
        return Err(GitError::new(
            GitErrorCode::Conflicts,
            "Resolve conflicts before committing",
        ));
    }
    if state
        .status
        .staged
        .iter()
        .any(|entry| is_ace_private(&entry.path))
    {
        return Err(GitError::new(
            GitErrorCode::PrivatePathStaged,
            "ace's own Recently deleted files are staged; unstage them before committing",
        ));
    }
    if let Some(fingerprint) = &request.draft_fingerprint {
        // A staged-only commit's draft was written for the staged files.
        let staged_paths: Vec<String> = state
            .status
            .staged
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        let drafted = crate::writes::context::draft_selection(
            paths.as_ref(),
            listed.as_ref(),
            request.staged_only,
            &staged_paths,
        );
        let matches = match drafted {
            Some(drafted) if !drafted.is_empty() => {
                crate::writes::context::writing_context(
                    port,
                    root,
                    temp_directory,
                    &crate::writes::context::SourceControlSelection::Commit { paths: drafted },
                )
                .await?
                .fingerprint
                    == *fingerprint
            }
            _ => false,
        };
        if !matches {
            return Err(head_moved(
                "Draft changes moved; regenerate or discard the draft",
            ));
        }
    }
    let named: Vec<String> = paths.clone().unwrap_or_default();
    if let Some(listed) = &listed {
        // The view listed these with nothing staged. Anything staged since (an agent's partial
        // hunk) would be replaced by `git add`: refuse, and let the person look again.
        if !state.status.staged.is_empty() {
            return Err(GitError::new(
                GitErrorCode::StagedMeanwhile,
                "Something was staged meanwhile. Review and commit again.",
            ));
        }
        observed.assert_head(request.expected_head.as_deref())?;
        stage_must_wait(port, root, &observed).await?;
        crate::writes::private::exclude_ace_private(port, root, is_windows).await?;
        // Ace's own bookkeeping is done; what the terminal staged before the add is still
        // theirs, so the index and HEAD are checked once more as close to the add as possible.
        observed.assert_head(request.expected_head.as_deref())?;
        stage_must_wait(port, root, &observed).await?;
        checked(port, add_all(root, listed)).await?;
        staged = checkout_snapshot(port, root).await?;
    } else if request.staged_only && paths.is_none() {
        if state.status.staged.is_empty() {
            return Err(GitError::new(
                GitErrorCode::NothingToCommit,
                "There is nothing staged to commit",
            ));
        }
    } else {
        let named = paths
            .as_ref()
            .map(|paths| dedupe(paths))
            .unwrap_or_else(|| vec![".".to_owned()]);
        // Stage what the working tree changed among them; a path already staged (a rename's old
        // name, a staged deletion) is in no worktree and `git add` would refuse it.
        let mut changed: Vec<String> = state
            .status
            .unstaged
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        changed.extend(state.status.untracked.iter().cloned());
        let staging: Vec<String> = if paths.is_some() {
            named
                .into_iter()
                .filter(|path| changed.iter().any(|changed| changed == path))
                .collect()
        } else {
            named
        };
        observed.assert_head(request.expected_head.as_deref())?;
        crate::writes::private::exclude_ace_private(port, root, is_windows).await?;
        if !staging.is_empty() {
            stage_must_wait(port, root, &observed).await?;
            checked(port, add_all(root, &staging)).await?;
            staged = checkout_snapshot(port, root).await?;
        }
    }
    // The commit takes the index ace just produced (or the one the caller staged) and HEAD as
    // it was observed; a stage or commit made meanwhile is a refusal, never something committed
    // in place of the caller's work.
    staged.assert_head(request.expected_head.as_deref())?;
    let now = checkout_snapshot(port, root).await?;
    now.assert_head(request.expected_head.as_deref())?;
    if now.index != staged.index {
        return Err(GitError::new(
            GitErrorCode::StagedMeanwhile,
            "Something was staged meanwhile. Review and commit again.",
        ));
    }
    let mut args: Vec<String> = vec!["commit".to_owned(), "--file=-".to_owned()];
    if paths.is_some() {
        args.push("--only".to_owned());
        args.push("--".to_owned());
        args.extend(dedupe(&named));
    }
    checked(
        port,
        long_writing(
            Command::owned(root, args)
                .with_input(message.as_bytes())
                .with_capture_bytes(65_536)
                .with_env(&[("GIT_TRACE2_EVENT", "1"), ("GIT_LITERAL_PATHSPECS", "1")]),
        ),
    )
    .await?;
    crate::reads::info::head(port, root).await?.ok_or_else(|| {
        GitError::new(
            GitErrorCode::UnbornHead,
            "The repository has no commits yet",
        )
    })
}

/// A stage made meanwhile is the caller's, never something ace's add may replace.
async fn stage_must_wait(
    port: &dyn CommandPort,
    root: &str,
    observed: &crate::writes::bind::CheckoutSnapshot,
) -> Result<(), GitError> {
    if observed.assert_index_unchanged(port, root).await.is_err() {
        return Err(GitError::new(
            GitErrorCode::StagedMeanwhile,
            "Something was staged meanwhile. Review and commit again.",
        ));
    }
    Ok(())
}

fn dedupe(paths: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if seen.insert(path.clone()) {
            out.push(path.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn request(message: &str) -> CommitRequest {
        CommitRequest {
            message: message.to_owned(),
            expected_head: None,
            paths: None,
            staged_only: false,
            stage_listed: None,
            draft_fingerprint: None,
        }
    }

    fn head(fixture: &Fixture, repo: &std::path::Path) -> String {
        String::from_utf8_lossy(&fixture.git(repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned()
    }

    // `client-actions.process`: commit all, commit paths only, and staged only.
    #[tokio::test]
    async fn a_commit_takes_every_change_or_only_the_named_paths() {
        let fixture = Fixture::new("g4a-commit");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        std::fs::write(repo.join("one.txt"), "one\n").expect("one");
        std::fs::write(repo.join("two.txt"), "two\n").expect("two");
        let mut all = request("  both changes \n");
        all.expected_head = Some(head(&fixture, &repo));
        let commit = commit_changes(&port, &root, &fixture.root.to_string_lossy(), &all, false)
            .await
            .expect("commit");
        assert_eq!(commit, head(&fixture, &repo));
        let subject = String::from_utf8_lossy(&fixture.git(&repo, &["log", "-1", "--format=%s"]))
            .trim_end()
            .to_owned();
        assert_eq!(subject, "both changes");

        // Only `one.txt`: the other change stays in the worktree.
        std::fs::write(repo.join("one.txt"), "one changed\n").expect("one");
        std::fs::write(repo.join("two.txt"), "two changed\n").expect("two");
        let mut only = request("one only");
        only.expected_head = Some(head(&fixture, &repo));
        only.paths = Some(vec!["one.txt".to_owned()]);
        commit_changes(&port, &root, &fixture.root.to_string_lossy(), &only, false)
            .await
            .expect("only");
        let status = crate::reads::status::state(&port, &root, &[])
            .await
            .expect("status");
        assert_eq!(status.status.unstaged.len(), 1);
        assert_eq!(status.status.unstaged[0].path, "two.txt");

        // Staged only: the committed index is what the person staged.
        crate::writes::stage::stage_paths(&port, &root, Some(&["two.txt".to_owned()]), false)
            .await
            .expect("stage");
        let mut staged = request("staged only");
        staged.expected_head = Some(head(&fixture, &repo));
        staged.staged_only = true;
        commit_changes(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &staged,
            false,
        )
        .await
        .expect("staged only");
        // Nothing staged is nothing to commit (with the new HEAD the caller now sees).
        staged.expected_head = Some(head(&fixture, &repo));
        let error = commit_changes(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &staged,
            false,
        )
        .await
        .expect_err("nothing staged");
        assert_eq!(error.code, GitErrorCode::NothingToCommit);
    }

    #[tokio::test]
    async fn a_moved_head_conflicts_private_paths_and_empty_messages_are_refused() {
        let fixture = Fixture::new("g4a-commit-refusals");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        let mut moved = request("moved");
        moved.expected_head = Some("b".repeat(40));
        assert_eq!(
            commit_changes(&port, &root, &fixture.root.to_string_lossy(), &moved, false)
                .await
                .expect_err("moved")
                .code,
            GitErrorCode::HeadMoved
        );
        assert_eq!(
            commit_changes(
                &port,
                &root,
                &fixture.root.to_string_lossy(),
                &request("   "),
                false
            )
            .await
            .expect_err("empty")
            .code,
            GitErrorCode::InvalidArgument
        );
        // A rename's old name is fine; no conflict is present in a one-commit checkout.
        let mut unlisted = request("listed");
        unlisted.expected_head = Some(head(&fixture, &repo));
        std::fs::write(repo.join("listed.txt"), "listed\n").expect("listed");
        unlisted.stage_listed = Some(vec!["listed.txt".to_owned()]);
        commit_changes(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &unlisted,
            false,
        )
        .await
        .expect("stage listed");
        // A change staged meanwhile makes stageListed refuse.
        std::fs::write(repo.join("listed.txt"), "again\n").expect("again");
        crate::writes::stage::stage_paths(&port, &root, Some(&["listed.txt".to_owned()]), false)
            .await
            .expect("stage");
        let mut meanwhile = request("listed again");
        meanwhile.expected_head = Some(head(&fixture, &repo));
        meanwhile.stage_listed = Some(vec!["listed.txt".to_owned()]);
        assert_eq!(
            commit_changes(
                &port,
                &root,
                &fixture.root.to_string_lossy(),
                &meanwhile,
                false
            )
            .await
            .expect_err("meanwhile")
            .code,
            GitErrorCode::StagedMeanwhile
        );
    }

    #[tokio::test]
    async fn a_commit_message_one_code_point_over_the_cap_is_refused() {
        let fixture = Fixture::new("g4a-overlong-message");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        std::fs::write(repo.join("file.txt"), "x\n").expect("file");
        let mut request = request(&"m".repeat(MAX_COMMIT_MESSAGE_LENGTH + 1));
        request.expected_head = crate::reads::info::head(&port, &repo.to_string_lossy())
            .await
            .expect("head");
        let error = commit_changes(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request,
            false,
        )
        .await
        .expect_err("overlong");
        assert_eq!(error.code, GitErrorCode::InvalidArgument);
        assert_eq!(error.message, "The commit message is too long");
    }

    // `z.string().trim()` uses the runtime's whitespace: U+0085 is not whitespace there (Rust's
    // `trim` would empty it and refuse), while U+FEFF IS whitespace (Rust's `trim` would leave it).
    #[tokio::test]
    async fn a_message_of_runtime_non_whitespace_commits_trimmed() {
        let fixture = Fixture::new("g4a-message-nel");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("file.txt"), "x\n").expect("file");
        let port = ProcessCommands { fixture: &fixture };
        let current = crate::reads::info::head(&port, &repo.to_string_lossy())
            .await
            .expect("head");
        // Only U+FEFF trims to empty and is refused.
        let mut bom_only = request("\u{FEFF} \u{FEFF}");
        bom_only.expected_head = current.clone();
        let error = commit_changes(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &bom_only,
            false,
        )
        .await
        .expect_err("bom-only message is empty");
        assert_eq!(error.code, GitErrorCode::InvalidArgument);
        assert_eq!(error.message, "A commit message is required");

        // U+FEFF is trimmed away while U+0085 is preserved as the committed message.
        let mut request = request("\u{FEFF}  \u{0085}  \u{FEFF}");
        request.expected_head = current;
        commit_changes(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request,
            false,
        )
        .await
        .expect("commit");
        let shown = String::from_utf8_lossy(&fixture.git(&repo, &["log", "-1", "--format=%B"]))
            .into_owned();
        assert_eq!(shown.trim_end_matches('\n'), "\u{0085}");
    }

    #[tokio::test]
    async fn the_pathspec_cap_counts_utf8_bytes_not_characters() {
        // `Buffer.byteLength`: 100 names of 1,000 emoji are individually valid (1,000 <= 4,096
        // code points) and 100,000 characters total, but 400,000 UTF-8 bytes — past the 256 KiB
        // cap; the same names in ASCII would be well inside it.
        let fixture = Fixture::new("g4a-pathspec-bytes");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let wide = "\u{1F600}".repeat(1_000);
        let paths: Vec<String> = (0..100).map(|_| wide.clone()).collect();
        let narrow: Vec<String> = (0..100).map(|_| "a".repeat(1_000)).collect();
        assert!(commit_paths(&narrow).is_ok());
        let mut req = request("wide paths");
        req.paths = Some(paths);
        let error = commit_changes(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &req,
            false,
        )
        .await
        .expect_err("over the byte cap");
        assert_eq!(error.code, GitErrorCode::InvalidArgument);
        assert_eq!(error.message, "Name between 1 and 1000 paths to commit");
    }

    #[tokio::test]
    async fn the_path_and_message_bounds_count_code_points_not_utf16_units() {
        // A zod bound counts code points: 4,096 emoji are 4,096 code points and 8,192 UTF-16
        // units, so the path is accepted; one more code point is not.
        let longest = "\u{1F600}".repeat(4096);
        assert!(commit_paths(std::slice::from_ref(&longest)).is_ok());
        assert_eq!(
            commit_paths(&[format!("{longest}\u{1F600}")])
                .expect_err("too long")
                .code,
            GitErrorCode::InvalidArgument
        );
        // The message's 65,536 bound counts code points too: 33,000 emoji (66,000 UTF-16 units)
        // commit, where a UTF-16 bound would refuse them.
        let fixture = Fixture::new("g4a-emoji-message");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        std::fs::write(repo.join("file.txt"), "changed\n").expect("change");
        let mut request = request(&"\u{1F600}".repeat(33_000));
        request.expected_head = crate::reads::info::head(&port, &repo.to_string_lossy())
            .await
            .expect("head");
        commit_changes(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request,
            false,
        )
        .await
        .expect("the message is within the code-point bound");
    }

    #[tokio::test]
    async fn a_draft_commits_only_while_its_fingerprint_still_describes_the_changes() {
        let fixture = Fixture::new("g4a-draft");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        std::fs::write(repo.join("file.txt"), "drafted\n").expect("draft");
        let context = crate::writes::context::writing_context(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &crate::writes::context::SourceControlSelection::Commit {
                paths: vec!["file.txt".to_owned()],
            },
        )
        .await
        .expect("context");
        let mut request = request("drafted");
        request.expected_head = Some(head(&fixture, &repo));
        request.paths = Some(vec!["file.txt".to_owned()]);
        request.draft_fingerprint = Some(context.fingerprint.clone());
        commit_changes(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &request,
            false,
        )
        .await
        .expect("the draft matches");
        // The same draft now describes old changes; the next commit must refuse it.
        std::fs::write(repo.join("file.txt"), "moved\n").expect("moved");
        let mut stale = request.clone();
        stale.expected_head = Some(head(&fixture, &repo));
        stale.draft_fingerprint = Some(context.fingerprint);
        assert_eq!(
            commit_changes(&port, &root, &fixture.root.to_string_lossy(), &stale, false,)
                .await
                .expect_err("moved")
                .code,
            GitErrorCode::HeadMoved
        );
    }

    #[tokio::test]
    async fn a_hunk_staged_after_the_empty_index_check_is_refused_and_kept() {
        let fixture = Fixture::new("g4-staged-meanwhile-race");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        std::fs::write(repo.join("listed.txt"), "listed\n").expect("listed");
        std::fs::write(repo.join("other.txt"), "other\n").expect("other");
        let mut listed = request("listed");
        listed.expected_head = crate::reads::info::head(&port, &root).await.expect("head");
        listed.stage_listed = Some(vec!["listed.txt".to_owned()]);
        // The terminal stages a partial hunk while ace writes its own exclude entry.
        let port = crate::writes::bind::test_support::InterceptingCommands::before_word(
            ProcessCommands { fixture: &fixture },
            "--git-common-dir",
            {
                let repo = repo.clone();
                move || {
                    let output = std::process::Command::new("git")
                        .current_dir(&repo)
                        .args(["add", "other.txt"])
                        .output()
                        .expect("stage");
                    assert!(output.status.success());
                }
            },
        );
        assert_eq!(
            commit_changes(
                &port,
                &root,
                &fixture.root.to_string_lossy(),
                &listed,
                false
            )
            .await
            .expect_err("meanwhile")
            .code,
            GitErrorCode::StagedMeanwhile
        );
        assert!(port.fired());
        // Their hunk is untouched and no commit was written.
        let status =
            crate::reads::status::status(&ProcessCommands { fixture: &fixture }, &root, &[])
                .await
                .expect("status");
        assert_eq!(
            status
                .staged
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["other.txt"]
        );
        let subject = String::from_utf8_lossy(&fixture.git(&repo, &["log", "-1", "--format=%s"]))
            .trim_end()
            .to_owned();
        assert_eq!(subject, "initial");
    }

    #[tokio::test]
    async fn a_head_advanced_after_the_draft_matched_is_refused_before_committing() {
        let fixture = Fixture::new("g4-draft-head-race");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        std::fs::write(repo.join("file.txt"), "drafted\n").expect("draft");
        let context = crate::writes::context::writing_context(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &crate::writes::context::SourceControlSelection::Commit {
                paths: vec!["file.txt".to_owned()],
            },
        )
        .await
        .expect("context");
        let mut request = request("drafted");
        request.expected_head = Some(head(&fixture, &repo));
        request.paths = Some(vec!["file.txt".to_owned()]);
        request.draft_fingerprint = Some(context.fingerprint);
        // The terminal commits between the draft check and ace's own commit.
        let port = crate::writes::bind::test_support::InterceptingCommands::before_word(
            ProcessCommands { fixture: &fixture },
            "--git-common-dir",
            {
                let repo = repo.clone();
                move || {
                    let output = std::process::Command::new("git")
                        .current_dir(&repo)
                        .args(["commit", "--allow-empty", "--quiet", "-m", "moved"])
                        .output()
                        .expect("commit");
                    assert!(output.status.success());
                }
            },
        );
        assert_eq!(
            commit_changes(
                &port,
                &root,
                &fixture.root.to_string_lossy(),
                &request,
                false
            )
            .await
            .expect_err("moved")
            .code,
            GitErrorCode::HeadMoved
        );
        assert!(port.fired());
        let subject = String::from_utf8_lossy(&fixture.git(&repo, &["log", "-1", "--format=%s"]))
            .trim_end()
            .to_owned();
        assert_eq!(subject, "moved");
    }

    #[tokio::test]
    async fn refusing_staged_meanwhile_and_nothing_to_commit_leaves_exclude_and_index_unchanged() {
        let fixture = Fixture::new("g4-exclude-refusal");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        let mut meanwhile = request("listed");
        meanwhile.expected_head = crate::reads::info::head(&port, &root).await.expect("head");
        meanwhile.stage_listed = Some(vec!["listed.txt".to_owned()]);
        std::fs::write(repo.join("other.txt"), "other\n").expect("other");
        crate::writes::stage::stage_paths(&port, &root, Some(&["other.txt".to_owned()]), false)
            .await
            .expect("stage");
        let exclude_before =
            std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default();
        let index_before = std::fs::read(repo.join(".git/index")).expect("index");
        std::fs::write(repo.join("listed.txt"), "listed\n").expect("listed");
        assert_eq!(
            commit_changes(
                &port,
                &root,
                &fixture.root.to_string_lossy(),
                &meanwhile,
                false,
            )
            .await
            .expect_err("meanwhile")
            .code,
            GitErrorCode::StagedMeanwhile
        );
        assert_eq!(
            std::fs::read(repo.join(".git/index")).expect("index"),
            index_before
        );
        assert_eq!(
            std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default(),
            exclude_before
        );
        let fresh = Fixture::new("g4-exclude-nothing");
        let repo = fresh.repository("repo");
        let port = ProcessCommands { fixture: &fresh };
        let root = repo.to_string_lossy().into_owned();
        let exclude_before =
            std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default();
        let index_before = std::fs::read(repo.join(".git/index")).expect("index");
        let mut nothing = request("nothing");
        nothing.expected_head = crate::reads::info::head(&port, &root).await.expect("head");
        nothing.staged_only = true;
        assert_eq!(
            commit_changes(&port, &root, &fresh.root.to_string_lossy(), &nothing, false,)
                .await
                .expect_err("nothing")
                .code,
            GitErrorCode::NothingToCommit
        );
        assert_eq!(
            std::fs::read(repo.join(".git/index")).expect("index"),
            index_before
        );
        assert_eq!(
            std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default(),
            exclude_before
        );
    }

    #[tokio::test]
    async fn a_conflicted_checkout_cannot_be_committed() {
        let fixture = Fixture::new("g4a-commit-conflict");
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
        let mut request = request("conflicted");
        request.expected_head = crate::reads::info::head(&port, &repo.to_string_lossy())
            .await
            .expect("head");
        assert_eq!(
            commit_changes(
                &port,
                &repo.to_string_lossy(),
                &fixture.root.to_string_lossy(),
                &request,
                false
            )
            .await
            .expect_err("conflicts")
            .code,
            GitErrorCode::Conflicts
        );
    }
}
