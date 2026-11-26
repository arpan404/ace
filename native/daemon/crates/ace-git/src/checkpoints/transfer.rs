// SPDX-License-Identifier: Apache-2.0
//! `captureChanges` (`packages/git/src/transfer-capture.ts`, G5): the checkout's uncommitted state
//! as a commit on HEAD at a caller's ref, with a temporary index so the person's checkout and index
//! are untouched.
//!
//! Repositories nested in the checkout, and linked worktrees inside it, are other checkouts and are
//! not captured. Tracked submodules travel as the commit they have checked out; a gitlink Git
//! adds for a directory that is not tracked is removed again. `None` when nothing changed.

use crate::checkpoints::nested::nested_checkouts;
use crate::checkpoints::snapshot::{SnapshotContext, env_pairs, with_snapshot_index};
use crate::core::decode::{hash, ref_schema};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::objects::ace_commit_env;
use crate::parse::index::parse_index;
use crate::reads::{Command, CommandPort, checked, text_output};

/// `transferRef`: a full ref the caller may write.
pub fn transfer_ref(reference: &str) -> Result<String, GitError> {
    if !reference.starts_with("refs/") || ref_schema(reference).is_none() {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            format!("Invalid ref: {reference}"),
        ));
    }
    Ok(reference.to_owned())
}

/// `headCommit`: HEAD's commit, or `None` on an unborn branch.
pub async fn head_commit(port: &dyn CommandPort, root: &str) -> Result<Option<String>, GitError> {
    let head = checked(
        port,
        Command::new(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
            .allowing_failure(),
    )
    .await?;
    if head.exit_code != 0 {
        return Ok(None);
    }
    Ok(Some(hash(&text_output(&head.stdout)?)?))
}

/// What a caller asks a capture for.
#[derive(Debug, Clone, Default)]
pub struct CaptureOptions<'a> {
    pub reference: &'a str,
    pub message: Option<&'a str>,
}

/// The commit a capture wrote, and the HEAD it was based on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    pub commit: String,
    pub head: Option<String>,
}

/// The transfers' identity: ace's own, never the person's `user.name` or signing.
fn transfer_identity(created_at: &str) -> [(&str, &str); 6] {
    let mut env = ace_commit_env(created_at);
    env[1] = ("GIT_AUTHOR_EMAIL", "transfers@ace.local");
    env[3] = ("GIT_COMMITTER_EMAIL", "transfers@ace.local");
    env
}

/// `captureChanges`: the uncommitted state as a commit at `options.reference`.
pub async fn capture_changes(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    now: &(dyn Fn() -> String + Sync),
    root: &str,
    options: &CaptureOptions<'_>,
) -> Result<Option<Captured>, GitError> {
    let reference = transfer_ref(options.reference)?;
    let head = head_commit(port, root).await?;
    let tree = with_snapshot_index(port, context, root, |env, seeded| {
        Box::pin(async move {
            let pairs = env_pairs(&env);
            let tracked: std::collections::HashSet<&str> = seeded
                .iter()
                .filter(|entry| entry.mode == "160000")
                .map(|entry| entry.path.as_str())
                .collect();
            // Other checkouts below this one (untracked nested repositories, linked worktrees)
            // stay out: Git cannot add one without commits, and one with commits would become a
            // bare gitlink.
            let found = nested_checkouts(port, root, &seeded, &pairs).await?;
            let filtered: Vec<&str> = found
                .repositories
                .iter()
                .chain(found.linked.iter())
                .map(String::as_str)
                .filter(|path| !tracked.contains(path))
                .collect();
            let mut pathspecs = String::from(":/\0");
            for path in filtered {
                pathspecs.push_str(&format!(":(top,exclude,literal){path}\0"));
            }
            checked(
                port,
                Command::new(
                    root,
                    &[
                        "add",
                        "--all",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                )
                .writing()
                .stopping_after(crate::core::deadline::LONG_WRITE_TIMEOUT_MS)
                .with_env(&pairs)
                .with_input(pathspecs.as_bytes()),
            )
            .await?;
            let current = parse_index(
                &checked(
                    port,
                    Command::new(root, &["ls-files", "--stage", "-z"]).with_env(&pairs),
                )
                .await?
                .stdout,
            )?;
            let embedded: Vec<&str> = current
                .iter()
                .filter(|entry| entry.mode == "160000" && !tracked.contains(entry.path.as_str()))
                .map(|entry| entry.path.as_str())
                .collect();
            if !embedded.is_empty() {
                let mut input = String::new();
                for path in embedded {
                    input.push_str(path);
                    input.push('\0');
                }
                checked(
                    port,
                    Command::new(root, &["update-index", "--force-remove", "-z", "--stdin"])
                        .writing()
                        .with_env(&pairs)
                        .with_input(input.as_bytes()),
                )
                .await?;
            }
            hash(&text_output(
                &checked(
                    port,
                    Command::new(root, &["write-tree"])
                        .writing()
                        .with_env(&pairs),
                )
                .await?
                .stdout,
            )?)
        })
    })
    .await?;
    let base = match &head {
        Some(head) => hash(&text_output(
            &checked(
                port,
                Command::new(
                    root,
                    &["rev-parse", "--verify", &format!("{head}^{{tree}}")],
                ),
            )
            .await?
            .stdout,
        )?)?,
        None => hash(&text_output(
            &checked(
                port,
                Command::new(root, &["hash-object", "-t", "tree", "--stdin"])
                    .writing()
                    .with_input(b""),
            )
            .await?
            .stdout,
        )?)?,
    };
    if tree == base {
        return Ok(None);
    }
    let created_at = now();
    let message = options
        .message
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .unwrap_or("Uncommitted changes");
    let mut args: Vec<&str> = vec!["-c", "commit.gpgSign=false", "commit-tree", &tree];
    if let Some(head) = &head {
        args.push("-p");
        args.push(head);
    }
    let commit = hash(&text_output(
        &checked(
            port,
            Command::new(root, &args)
                .writing()
                .with_env(&transfer_identity(&created_at))
                .with_input(format!("{message}\n").as_bytes()),
        )
        .await?
        .stdout,
    )?)?;
    checked(
        port,
        Command::new(root, &["update-ref", &reference, &commit]).writing(),
    )
    .await?;
    Ok(Some(Captured { commit, head }))
}

#[cfg(test)]
mod tests;
