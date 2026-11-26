// SPDX-License-Identifier: Apache-2.0
//! Checkpoint writes and reads (`packages/git/src/checkpoints.ts`, G5): the snapshot becomes a
//! commit, its ref and the thread's counter are published in one transaction, and a lost race is
//! retried instead of guessed at.
//!
//! The counter is compare-and-swap: `update-ref --stdin` names the old counter commit, so a
//! competing transaction either publishes both refs or neither. Twenty attempts, 25 ms apart, then
//! the last failure. A `.lock` another transaction holds is not fatal on its own: the counter can
//! still be unchanged while the lock is held.

use crate::checkpoints::bytes::{bytes_tree, forget_bytes, record_bytes};
use crate::checkpoints::metadata::{
    Checkpoint, MAX_SEQUENCE, checkpoint, checkpoint_prefix, metadata_message, parse_commits,
};
use crate::checkpoints::nested::{Capture, Ownership};
use crate::checkpoints::numbers::{CheckpointNumbers, checkpoint_refs, counter_ref};
use crate::checkpoints::snapshot::{SnapshotContext, snapshot};
use crate::core::decode::{hash, malformed};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::objects::ace_commit_env;
use crate::core::spawn::BoxFuture;
use crate::reads::{Command, CommandPort, checked, text_output};

/// The allocation attempts before the last failure is reported.
pub const ATTEMPTS: usize = 20;
/// The pause after attempt `n`: `min(250, 25 * (n + 1))` milliseconds.
pub fn retry_pause_ms(attempt: usize) -> u64 {
    (25 * (attempt as u64 + 1)).min(250)
}

/// `--format=%H%x00%T%x00%B`: one commit's id, tree and message, for `git log`.
pub const LOG_FORMAT: &str = "--format=%H%x00%T%x00%B";
/// How many commits one `git log` batch names.
pub const LOG_BATCH: usize = 500;

/// The pause between allocation attempts (`repository.cli.pause`), a port so tests need not wait.
pub trait Wait: Sync {
    fn wait<'a>(&'a self, milliseconds: u64) -> BoxFuture<'a, ()>;
}

/// The daemon's pause: tokio's timer, as `GitCli.pause` schedules one.
pub struct TokioWait;

impl Wait for TokioWait {
    fn wait<'a>(&'a self, milliseconds: u64) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
        })
    }
}

/// Everything one checkpoint allocation needs, so the call names its inputs rather than
/// carrying nine arguments.
pub struct CreateCheckpoint<'a> {
    pub port: &'a dyn CommandPort,
    pub context: &'a SnapshotContext,
    pub numbers: &'a mut CheckpointNumbers,
    pub wait: &'a dyn Wait,
    pub root: &'a str,
    pub thread_id: &'a str,
    pub label: &'a str,
    pub ownership: Option<&'a Ownership>,
    pub capture: &'a dyn Capture,
}

/// `createCheckpoint`: the snapshot's tree as a commit, allocated a sequence and published.
pub async fn create_checkpoint(request: CreateCheckpoint<'_>) -> Result<Checkpoint, GitError> {
    let CreateCheckpoint {
        port,
        context,
        numbers,
        wait,
        root,
        thread_id,
        label,
        ownership,
        capture,
    } = request;
    let prefix = checkpoint_prefix(thread_id)?;
    let tree = snapshot(port, context, root, ownership, capture).await?;
    // Windows: `tree` is what Git stores after line-ending conversion; a restore needs the bytes.
    let bytes = if context.platform == "win32" {
        Some(bytes_tree(port, &context.temp_directory, root, &tree).await?)
    } else {
        None
    };
    let created_at = (context.now)();
    let mut last_failure = String::from("Checkpoint refs changed repeatedly; retry the operation");
    for attempt in 0..ATTEMPTS {
        let previous = numbers.get(port, root, thread_id).await?;
        let Some(sequence) = sequence_after(previous.sequence) else {
            return Err(GitError::new(
                GitErrorCode::GitFailed,
                "Checkpoint sequence exhausted",
            ));
        };
        let message = metadata_message(thread_id, label, &created_at, sequence);
        let sha = hash(&text_output(
            &checked(
                port,
                Command::new(root, &["-c", "commit.gpgSign=false", "commit-tree", &tree])
                    .writing()
                    .with_env(&ace_commit_env(&created_at))
                    .with_input(format!("{message}\n").as_bytes()),
            )
            .await?
            .stdout,
        )?)?;
        if let Some(bytes) = bytes.as_deref().filter(|bytes| *bytes != tree) {
            record_bytes(port, root, thread_id, &sha, bytes, &created_at).await?;
        }
        let id = format!("{prefix}{sequence}");
        let previous_ref = previous
            .sha
            .clone()
            .unwrap_or_else(|| "0".repeat(sha.len()));
        let input = format!(
            "start\ncreate {id} {sha}\nupdate {} {sha} {previous_ref}\nprepare\ncommit\n",
            counter_ref(thread_id)?
        );
        let result = checked(
            port,
            Command::new(root, &["update-ref", "--stdin"])
                .writing()
                .allowing_failure()
                .with_input(input.as_bytes()),
        )
        .await?;
        if result.exit_code == 0 {
            numbers.remember(
                root,
                thread_id,
                crate::checkpoints::numbers::Counter {
                    sha: Some(sha.clone()),
                    sequence,
                },
            );
            return Ok(Checkpoint {
                id,
                sha,
                tree,
                thread_id: thread_id.to_owned(),
                sequence,
                label: label.to_owned(),
                created_at,
            });
        }
        last_failure = result.stderr;
        let current = numbers.refresh(port, root, thread_id).await?;
        // A competing transaction can still hold the ref lock before publishing its new counter.
        // An unchanged counter does not make that lock fatal.
        let locked = ref_locked(&last_failure);
        if current.sha == previous.sha && !locked {
            return Err(GitError::new(GitErrorCode::GitFailed, last_failure));
        }
        if attempt + 1 < ATTEMPTS {
            wait.wait(retry_pause_ms(attempt)).await;
        }
    }
    Err(GitError::new(GitErrorCode::GitFailed, last_failure))
}

/// `Number.isSafeInteger(sequence + 1)`: the sequence stays printable as one JSON integer.
fn sequence_after(previous: u64) -> Option<u64> {
    let sequence = previous.checked_add(1)?;
    (sequence as f64 <= MAX_SEQUENCE).then_some(sequence)
}

/// `/cannot lock ref[\s\S]*\.lock'[\s\S]*File exists/`: a lock another transaction holds.
fn ref_locked(stderr: &str) -> bool {
    let Some(cannot) = stderr.find("cannot lock ref") else {
        return false;
    };
    let rest = &stderr[cannot..];
    let Some(lock) = rest.find(".lock'") else {
        return false;
    };
    rest[lock..].contains("File exists")
}

/// `readCheckpoint`: one commit by id, refused when it is not exactly one.
pub async fn read_checkpoint(
    port: &dyn CommandPort,
    root: &str,
    id: &str,
) -> Result<Checkpoint, GitError> {
    crate::checkpoints::metadata::checkpoint_identity(id)?;
    let output = checked(
        port,
        Command::new(
            root,
            &[
                "log",
                "--no-color",
                "--no-show-signature",
                "--no-walk=unsorted",
                "-z",
                LOG_FORMAT,
                id,
                "--",
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if output.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::CheckpointNotFound,
            format!("Checkpoint not found: {id}"),
        ));
    }
    let commits = parse_commits(&output.stdout)?;
    let commit = commits.values().next();
    match (commits.len(), commit) {
        (1, Some(commit)) => checkpoint(id, commit),
        _ => Err(malformed("checkpoint commit arity")),
    }
}

/// `listCheckpoints`: every ref of the thread, its commit read in batches of 500.
pub async fn list_checkpoints(
    port: &dyn CommandPort,
    root: &str,
    thread_id: &str,
) -> Result<Vec<Checkpoint>, GitError> {
    let refs = checkpoint_refs(port, root, thread_id).await?;
    let mut unique: Vec<String> = Vec::new();
    for reference in &refs {
        if !unique.contains(&reference.sha) {
            unique.push(reference.sha.clone());
        }
    }
    let mut commits: indexmap::IndexMap<String, crate::checkpoints::metadata::ParsedCommit> =
        indexmap::IndexMap::new();
    for batch in unique.chunks(LOG_BATCH) {
        let mut args: Vec<&str> = vec![
            "log",
            "--no-color",
            "--no-show-signature",
            "--no-walk=unsorted",
            "-z",
            LOG_FORMAT,
        ];
        args.extend(batch.iter().map(String::as_str));
        args.push("--");
        let output = checked(port, Command::new(root, &args)).await?;
        let decoded = parse_commits(&output.stdout)?;
        if decoded.len() != batch.len() || decoded.keys().any(|sha| !batch.contains(sha)) {
            return Err(malformed("checkpoint batch correspondence"));
        }
        for (sha, data) in decoded {
            commits.insert(sha, data);
        }
    }
    let mut checkpoints = Vec::with_capacity(refs.len());
    for reference in refs {
        let commit = commits
            .get(&reference.sha)
            .ok_or_else(|| malformed("missing checkpoint commit"))?;
        checkpoints.push(checkpoint(&reference.id, commit)?);
    }
    Ok(checkpoints)
}

/// `deleteCheckpoints`: every ref of the thread, its counter, in one transaction.
pub async fn delete_checkpoints(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    numbers: &mut CheckpointNumbers,
    root: &str,
    thread_id: &str,
) -> Result<usize, GitError> {
    let current = numbers.refresh(port, root, thread_id).await?;
    // Capture the counter before enumerating refs so a later allocation cannot become the
    // generation we delete while its checkpoint escapes enumeration.
    let refs = checkpoint_refs(port, root, thread_id).await?;
    let object_format = if current.sha.is_some() {
        None
    } else {
        let format = text_output(
            &checked(
                port,
                Command::new(root, &["rev-parse", "--show-object-format"]),
            )
            .await?
            .stdout,
        )?;
        match format.as_str() {
            "sha1" | "sha256" => Some(format),
            _ => return Err(malformed("object format")),
        }
    };
    let mut input = String::from("start\n");
    for reference in &refs {
        input.push_str(&format!("delete {} {}\n", reference.id, reference.sha));
    }
    match &current.sha {
        Some(sha) => input.push_str(&format!("delete {} {sha}\n", counter_ref(thread_id)?)),
        None => input.push_str(&format!(
            "verify {} {}\n",
            counter_ref(thread_id)?,
            "0".repeat(if object_format.as_deref() == Some("sha256") {
                64
            } else {
                40
            })
        )),
    }
    input.push_str("prepare\ncommit\n");
    checked(
        port,
        Command::new(root, &["update-ref", "--stdin"])
            .writing()
            .with_input(input.as_bytes()),
    )
    .await?;
    if context.platform == "win32" {
        forget_bytes(port, root, thread_id).await?;
    }
    numbers.forget(root, thread_id);
    Ok(refs.len())
}

#[cfg(test)]
mod tests;
