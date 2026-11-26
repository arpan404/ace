// SPDX-License-Identifier: Apache-2.0
//! The snapshot (S1–S13, `packages/git/src/snapshot-index.ts` and `checkpoints.ts`'s `snapshot`,
//! G5): the same commands in the same order with the same temporary-index settings, so the tree
//! is the checkout's bytes as Git sees them.
//!
//! S1 refuses a sparse checkout; S2 makes a temporary index; S3 reads HEAD's tree and the
//! person's index (read only, never written); S4 loads HEAD's tree; S5 seeds the person's stage-0
//! rows; S6 reads the result back; S7 discovers nested checkouts and the excluded set; S8 removes
//! gitlinks; S9 selects the pathspecs; S10 adds everything; S11 flattens nested repositories;
//! S12 refuses any surviving gitlink; S13 writes the tree.
//!
//! G6 changes S9–S10 only, on the native path. Until it lands, every snapshot hashes every file
//! with Git's own `add`.

use crate::checkpoints::nested::{
    Capture, Ownership, flatten_nested, gitlinks_unsupported, nested_checkouts, owned_children,
};
use crate::core::decode::{hash, nul, path_schema};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::spawn::BoxFuture;
use crate::core::temp_index::{TemporaryIndex, with_setting};
use crate::parse::index::{IndexEntry, parse_index};
use crate::reads::{Command, CommandPort, checked, text_output};

/// The temporary-index settings, as `GitCli.call` carries them.
pub fn env_pairs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

/// The parts of `Repository` a snapshot reads that are not Git commands.
pub struct SnapshotContext {
    /// `repository.tempDirectory`: the temporary index's parent.
    pub temp_directory: String,
    /// `cli.platform`: Windows adds `core.safecrlf=false` to every snapshot call.
    pub platform: String,
    /// `repository.now()`: the injection point for the clock, as an ISO timestamp.
    pub now: Box<dyn Fn() -> String + Send + Sync>,
}

impl SnapshotContext {
    fn is_windows(&self) -> bool {
        self.platform == "win32"
    }
}

/// `sparseCheckout`: `core.sparseCheckout` through `config --type=bool`, refusing an unreadable
/// answer.
async fn sparse_checkout(port: &dyn CommandPort, root: &str) -> Result<bool, GitError> {
    let sparse = checked(
        port,
        Command::new(
            root,
            &["config", "--type=bool", "--get", "core.sparseCheckout"],
        )
        .allowing_failure(),
    )
    .await?;
    if sparse.exit_code != 0 && sparse.exit_code != 1 {
        return Err(GitError::new(GitErrorCode::GitFailed, sparse.stderr));
    }
    if sparse.exit_code != 0 {
        return Ok(false);
    }
    match text_output(&sparse.stdout)?.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(crate::core::decode::malformed("sparse checkout config")),
    }
}

/// `withSnapshotIndex` (S1–S6): a temporary index seeded with HEAD's tree and the person's
/// stage-0 rows, then the operation.
pub async fn with_snapshot_index<'a, T>(
    port: &'a dyn CommandPort,
    context: &'a SnapshotContext,
    root: &'a str,
    operation: impl FnOnce(Vec<(String, String)>, Vec<IndexEntry>) -> BoxFuture<'a, Result<T, GitError>>,
) -> Result<T, GitError> {
    if sparse_checkout(port, root).await? {
        return Err(GitError::new(
            GitErrorCode::UnsupportedRepository,
            "Full working-tree snapshots do not support sparse checkout",
        ));
    }
    let index = TemporaryIndex::create(&context.temp_directory)?;
    // Windows: a snapshot only records the checkout. A person's `core.safecrlf=true` must not
    // refuse a file whose line endings Git would not round-trip.
    let env = if context.is_windows() {
        with_setting(index.env().to_vec(), "core.safecrlf", "false")
    } else {
        index.env().to_vec()
    };
    let pairs = env_pairs(&env);
    // Independent reads: HEAD's tree and the checkout's own index (only read, never written).
    let head = checked(
        port,
        Command::new(root, &["rev-parse", "--verify", "HEAD^{tree}"]).allowing_failure(),
    )
    .await?;
    let listing = checked(port, Command::new(root, &["ls-files", "--stage", "-z"])).await?;
    let tree = if head.exit_code == 0 {
        text_output(&head.stdout)?
    } else {
        String::new()
    };
    let mut read_tree: Vec<&str> = vec!["read-tree"];
    if tree.is_empty() {
        read_tree.push("--empty");
    } else {
        read_tree.push(&tree);
    }
    checked(
        port,
        Command::new(root, &read_tree).writing().with_env(&pairs),
    )
    .await?;
    let tracked = parse_index(&listing.stdout)?;
    let mut seed = String::new();
    for entry in &tracked {
        seed.push_str(&format!("{} {} 0\t{}\0", entry.mode, entry.sha, entry.path));
    }
    checked(
        port,
        Command::new(root, &["update-index", "-z", "--index-info"])
            .writing()
            .with_env(&pairs)
            .with_input(seed.as_bytes()),
    )
    .await?;
    let seeded = parse_index(
        &checked(
            port,
            Command::new(root, &["ls-files", "--stage", "-z"]).with_env(&pairs),
        )
        .await?
        .stdout,
    )?;
    operation(env, seeded).await
}

/// `snapshot`: the checkout's tree, nested repositories flattened into it.
pub async fn snapshot(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    root: &str,
    ownership: Option<&Ownership>,
    capture: &dyn Capture,
) -> Result<String, GitError> {
    with_snapshot_index(port, context, root, |env, seeded| {
        Box::pin(async move {
            let pairs = env_pairs(&env);
            let found = nested_checkouts(port, root, &seeded, &pairs).await?;
            let nested = match ownership {
                Some(ownership) => owned_children(ownership, root)?.to_vec(),
                None => found.repositories,
            };
            // Linked worktrees of this repository are other checkouts, never part of this one's
            // state.
            let mut excluded = nested.clone();
            excluded.extend(found.linked);
            remove_gitlinks(port, root, &seeded, &pairs).await?;
            let paths = snapshot_paths(port, root, &excluded, &pairs).await?;
            if !paths.is_empty() {
                // Hashing a whole checkout can outlast the short metadata-read deadline.
                let mut input = String::new();
                for path in &paths {
                    input.push_str(path);
                    input.push('\0');
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
                    .with_input(input.as_bytes()),
                )
                .await?;
            }
            flatten_nested(port, root, &nested, &pairs, capture, context.now.as_ref()).await?;
            let current = parse_index(
                &checked(
                    port,
                    Command::new(root, &["ls-files", "--stage", "-z"]).with_env(&pairs),
                )
                .await?
                .stdout,
            )?;
            if current.iter().any(|entry| entry.mode == "160000") {
                return Err(gitlinks_unsupported());
            }
            let tree = text_output(
                &checked(
                    port,
                    Command::new(root, &["write-tree"])
                        .writing()
                        .with_env(&pairs),
                )
                .await?
                .stdout,
            )?;
            hash(&tree)
        })
    })
    .await
}

/// S8: gitlinks are removed before the add, so a submodule's own contents never enter the tree.
async fn remove_gitlinks(
    port: &dyn CommandPort,
    root: &str,
    seeded: &[IndexEntry],
    env: &[(&str, &str)],
) -> Result<(), GitError> {
    let gitlinks: Vec<&IndexEntry> = seeded
        .iter()
        .filter(|entry| entry.mode == "160000")
        .collect();
    if gitlinks.is_empty() {
        return Ok(());
    }
    let mut input = String::new();
    for entry in gitlinks {
        input.push_str(&entry.path);
        input.push('\0');
    }
    checked(
        port,
        Command::new(root, &["update-index", "--force-remove", "-z", "--stdin"])
            .writing()
            .with_env(env)
            .with_input(input.as_bytes()),
    )
    .await?;
    Ok(())
}

/// S9: Git can reject an excluded, ignored directory as an explicit ignored pathspec, so only
/// this root's tracked and unignored files are selected; a child repository keeps exclusive
/// filter and index ownership.
async fn snapshot_paths(
    port: &dyn CommandPort,
    root: &str,
    excluded: &[String],
    env: &[(&str, &str)],
) -> Result<Vec<String>, GitError> {
    if excluded.is_empty() {
        return Ok(vec![String::from(".")]);
    }
    let listing = checked(
        port,
        Command::new(
            root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )
        .with_env(env),
    )
    .await?;
    let mut seen: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for record in nul(&listing.stdout)? {
        seen.insert(record);
    }
    let mut paths = Vec::new();
    for record in seen {
        let path = path_schema(if record.ends_with('/') {
            &record[..record.len() - 1]
        } else {
            &record
        })
        .ok_or_else(|| crate::core::decode::malformed("snapshot path"))?;
        if excluded
            .iter()
            .any(|child| path == *child || path.starts_with(&format!("{child}/")))
        {
            continue;
        }
        paths.push(format!(":(literal){path}"));
    }
    Ok(paths)
}

#[cfg(test)]
mod tests;
