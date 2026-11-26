// SPDX-License-Identifier: Apache-2.0
//! Object transfer between checkouts of one filesystem (`packages/git/src/object-transfer.ts`,
//! ported here because the checkpoint snapshot and G4c's transfers both need it). Git reads and
//! transports object bytes; this only hands one command's stdout to the next command's stdin.
//!
//! The TypeScript pipes `pack-objects` into `unpack-objects` while both run. A [`CommandPort`]
//! answers with a whole capture, so the pack is held once between the two commands. The bytes,
//! the commands and their order are the same; only the peak memory differs, and a pack larger
//! than the capture bound fails with `output_too_large` where the TypeScript streamed it.

use crate::core::decode::hash;
use crate::core::error::GitError;
use crate::reads::{Command, CommandPort, checked, text_output};

/// The environment every `ace` commit carries (`object-transfer.ts:44`-`:51`).
pub fn ace_commit_env(created_at: &str) -> [(&str, &str); 6] {
    [
        ("GIT_AUTHOR_NAME", "ace"),
        ("GIT_AUTHOR_EMAIL", "checkpoints@ace.local"),
        ("GIT_COMMITTER_NAME", "ace"),
        ("GIT_COMMITTER_EMAIL", "checkpoints@ace.local"),
        ("GIT_AUTHOR_DATE", created_at),
        ("GIT_COMMITTER_DATE", created_at),
    ]
}

/// `transferObjects`: the commit's reachable objects from `from` into `to`.
pub async fn transfer_objects(
    port: &dyn CommandPort,
    from: &str,
    to: &str,
    commit: &str,
) -> Result<(), GitError> {
    let packed = checked(
        port,
        Command::new(from, &["pack-objects", "--stdout", "--revs"])
            .with_input(format!("{commit}\n").as_bytes()),
    )
    .await?;
    checked(
        port,
        Command::new(to, &["unpack-objects", "-q"])
            .writing()
            .with_input(&packed.stdout),
    )
    .await?;
    Ok(())
}

/// `transferTree`: one tree, committed under `from`, then its objects copied to `to`.
pub async fn transfer_tree(
    port: &dyn CommandPort,
    from: &str,
    to: &str,
    tree: &str,
    created_at: &str,
) -> Result<(), GitError> {
    let output = checked(
        port,
        Command::new(from, &["-c", "commit.gpgSign=false", "commit-tree", tree])
            .writing()
            .with_env(&ace_commit_env(created_at))
            .with_input(b"ace nested snapshot\n"),
    )
    .await?;
    let commit = hash(&text_output(&output.stdout)?)?;
    transfer_objects(port, from, to, &commit).await
}

#[cfg(test)]
mod tests;
