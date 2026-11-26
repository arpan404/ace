// SPDX-License-Identifier: Apache-2.0
//! Restore (`packages/git/src/restore.ts` and `restore-nested.ts`, G5): today's restore, step for
//! step. A safety checkpoint of the whole hierarchy is taken first, then the target's tree is
//! materialized with `read-tree --reset -u`, one repository at a time.
//!
//! ADR 0224 §5a's guard (the touch-set witness, the check before every write) is new behaviour
//! that lands in TypeScript first; until it does, this is the TypeScript's restore exactly: the
//! safety checkpoint is the recovery point, and collisions with ignored paths are refused before
//! anything is written.
//!
//! Child locks: the caller holds the outer root; descendants are acquired in hierarchy order and
//! held through the safety capture and every filesystem change (`Lock`).

use std::collections::HashSet;

use crate::checkpoints::bytes::{checkpoint_bytes, exact_checkout_args};
use crate::checkpoints::create::{CreateCheckpoint, Wait, create_checkpoint};
use crate::checkpoints::metadata::Checkpoint;
use crate::checkpoints::nested::{
    Capture, Ownership, assert_no_gitlinks, ignored_paths, nested_paths, nested_root,
    repository_paths,
};
use crate::checkpoints::numbers::CheckpointNumbers;
use crate::checkpoints::snapshot::{SnapshotContext, env_pairs, snapshot, with_snapshot_index};
use crate::core::decode::{hash, malformed, nul, path_ancestors, path_schema};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::objects::transfer_tree;
use crate::core::spawn::BoxFuture;
use crate::core::temp_index::TemporaryIndex;
use crate::parse::index::{parse_tree, remove_index_subtrees};
use crate::reads::{Command, CommandPort, checked, text_output};

/// One nested checkout a restore owns, with its own descendants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub path: String,
    pub root: String,
    pub children: Vec<Node>,
}

/// A checkout whose lease is held (`repository.serial`). The id is the caller's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Guard(pub u64);

/// The lease around one checkout, as `Repository.serial` takes it: the caller holds the outer
/// root, and `with_nested_worktrees` acquires every descendant through this.
pub trait Lock: Sync {
    fn acquire<'a>(&'a self, root: &'a str) -> BoxFuture<'a, Result<Guard, GitError>>;
    fn release(&self, guard: Guard);
}

/// `withNestedWorktrees`: discover the hierarchy, hold every child's lease, then run the
/// operation. The ownership map names each root's children in hierarchy order.
pub async fn with_nested_worktrees<'a, T>(
    port: &'a dyn CommandPort,
    context: &'a SnapshotContext,
    root: &str,
    lock: &'a dyn Lock,
    operation: impl FnOnce(Vec<Node>, Ownership) -> BoxFuture<'a, Result<T, GitError>>,
) -> Result<T, GitError> {
    let mut ownership = Ownership::new();
    let mut guards = Vec::new();
    let children = discover(port, context, root, &mut ownership, lock, &mut guards).await?;
    let result = operation(children, ownership).await;
    for guard in guards {
        lock.release(guard);
    }
    result
}

async fn discover(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    parent: &str,
    ownership: &mut Ownership,
    lock: &dyn Lock,
    guards: &mut Vec<Guard>,
) -> Result<Vec<Node>, GitError> {
    let paths = with_snapshot_index(port, context, parent, |env, tracked| {
        Box::pin(async move {
            let pairs = env_pairs(&env);
            nested_paths(port, parent, &tracked, &pairs).await
        })
    })
    .await?;
    let mut children = Vec::new();
    for path in paths {
        let child = nested_root(port, parent, &path).await?;
        guards.push(lock.acquire(&child).await?);
        let descendants =
            Box::pin(discover(port, context, &child, ownership, lock, guards)).await?;
        children.push(Node {
            path,
            root: child,
            children: descendants,
        });
    }
    ownership.insert(
        parent.to_owned(),
        children.iter().map(|child| child.path.clone()).collect(),
    );
    Ok(children)
}

/// The snapshot one restore's safety capture takes: the same port and context, the ownership the
/// hierarchy names, and never a lease of its own (every root is already held).
struct Held<'a> {
    port: &'a dyn CommandPort,
    context: &'a SnapshotContext,
    ownership: &'a Ownership,
}

impl Capture for Held<'_> {
    fn capture<'a>(&'a self, root: &'a str) -> BoxFuture<'a, Result<String, GitError>> {
        Box::pin(async move {
            snapshot(self.port, self.context, root, Some(self.ownership), self).await
        })
    }
}

/// Everything one restore needs.
pub struct RestoreCheckpoint<'a> {
    pub port: &'a dyn CommandPort,
    pub context: &'a SnapshotContext,
    pub numbers: &'a mut CheckpointNumbers,
    pub wait: &'a dyn Wait,
    pub lock: &'a dyn Lock,
    pub root: &'a str,
    pub id: &'a str,
}

/// What a restore leaves behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    pub safety_checkpoint_id: String,
}

/// `restoreCheckpoint`: the safety capture, the checks, then the checkout.
pub async fn restore_checkpoint<'a>(request: RestoreCheckpoint<'a>) -> Result<Restored, GitError> {
    let RestoreCheckpoint {
        port,
        context,
        numbers,
        wait,
        lock,
        root,
        id,
    } = request;
    let target = crate::checkpoints::create::read_checkpoint(port, root, id).await?;
    with_nested_worktrees(port, context, root, lock, move |children, ownership| {
        Box::pin(async move {
            let capture = Held {
                port,
                context,
                ownership: &ownership,
            };
            let label = format!("Before restore of {id}");
            let safety = create_checkpoint(CreateCheckpoint {
                port,
                context,
                numbers,
                wait,
                root,
                thread_id: &target.thread_id,
                label: &label,
                ownership: Some(&ownership),
                capture: &capture,
            })
            .await?;
            let safety_id = safety.id.clone();
            match restore_body(port, context, root, &safety, &target, children, &ownership).await {
                Ok(()) => Ok(Restored {
                    safety_checkpoint_id: safety_id,
                }),
                Err(error) => {
                    Err(error.with_detail("safetyCheckpointId", ace_json::json!(safety_id)))
                }
            }
        })
    })
    .await
}

fn collision(path: &str) -> GitError {
    GitError::new(
        GitErrorCode::RestoreCollision,
        format!("Checkpoint would overwrite ignored path: {path}"),
    )
}

async fn restore_body(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    root: &str,
    safety: &Checkpoint,
    target: &Checkpoint,
    children: Vec<Node>,
    ownership: &Ownership,
) -> Result<(), GitError> {
    assert_no_gitlinks(port, root, &target.tree).await?;
    // The flattened safety tree lets Git see ignored contents below uninitialized gitlinks, which
    // the person's opaque gitlink index would hide.
    let ignored = {
        let index = TemporaryIndex::create(&context.temp_directory)?;
        let env = env_pairs(index.env());
        checked(
            port,
            Command::new(root, &["read-tree", &safety.tree])
                .writing()
                .with_env(&env),
        )
        .await?;
        ignored_paths(port, root, &env, Some(ownership)).await?
    };
    let mut target_paths: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    let listing = checked(
        port,
        Command::new(root, &["ls-tree", "-r", "--name-only", "-z", &target.tree]),
    )
    .await?;
    for record in nul(&listing.stdout)? {
        let path = path_schema(&record).ok_or_else(|| malformed("restore path"))?;
        target_paths.insert(path);
    }
    let mut ignored = ignored;
    for path in repository_paths(root, target_paths.iter().cloned().collect())? {
        // Administrative data is excluded from snapshots and must never be replaced.
        ignored.push(format!("{path}/.git"));
    }
    let mut target_ancestors: HashSet<String> = HashSet::new();
    for path in &target_paths {
        for ancestor in path_ancestors(path) {
            target_ancestors.insert(ancestor);
        }
    }
    // A reset can overwrite ignored files, or an ignored directory when restoring a file.
    // Refuse those collisions instead of silently losing files outside the snapshot.
    for path in &ignored {
        if target_ancestors.contains(path) {
            return Err(collision(path));
        }
        for ancestor in path_ancestors(path) {
            if target_paths.contains(&ancestor) {
                return Err(collision(path));
            }
        }
    }
    // `read-tree` refuses to follow symlink directories and owns all path operations.
    // Windows: write the checkpoint's own bytes back, unconverted, where this Git can.
    if context.platform == "win32" && exact_checkout_args(port, root).await?.is_some() {
        let before = checkpoint_bytes(port, root, safety).await?;
        let after = checkpoint_bytes(port, root, target).await?;
        Box::pin(restore_worktree(
            port, context, root, &before, &after, &children,
        ))
        .await
    } else {
        Box::pin(restore_worktree(
            port,
            context,
            root,
            &safety.tree,
            &target.tree,
            &children,
        ))
        .await
    }
}

/// `restoreWorktree`: materialize only this repository's files; children own their filters and
/// deletions, including when the target has no subtree for an existing child.
async fn restore_worktree(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    root: &str,
    before: &str,
    target: &str,
    children: &[Node],
) -> Result<(), GitError> {
    let created_at = (context.now)();
    {
        let index = TemporaryIndex::create(&context.temp_directory)?;
        let env = env_pairs(index.env());
        let from = owned_tree(port, root, before, children, &env).await?;
        let to = owned_tree(port, root, target, children, &env).await?;
        checked(
            port,
            Command::new(root, &["read-tree", &from])
                .writing()
                .with_env(&env),
        )
        .await?;
        // Windows: the trees hold the files' own bytes; check them out without any conversion.
        let exact = if context.platform == "win32" {
            exact_checkout_args(port, root).await?
        } else {
            None
        };
        let mut args: Vec<String> = exact.unwrap_or_default();
        args.push(String::from("read-tree"));
        args.extend([
            String::from("--reset"),
            String::from("-u"),
            String::from("--no-sparse-checkout"),
            to.clone(),
        ]);
        checked(port, Command::owned(root, args).writing().with_env(&env)).await?;
    }
    for child in children {
        let from = subtree(port, context, root, before, &child.path).await?;
        let to = subtree(port, context, root, target, &child.path).await?;
        transfer_tree(port, root, &child.root, &from, &created_at).await?;
        if to != from {
            transfer_tree(port, root, &child.root, &to, &created_at).await?;
        }
        Box::pin(restore_worktree(
            port,
            context,
            &child.root,
            &from,
            &to,
            &child.children,
        ))
        .await?;
    }
    Ok(())
}

/// The tree without the children's own subtrees: a nested repository's files are its own.
async fn owned_tree(
    port: &dyn CommandPort,
    root: &str,
    tree: &str,
    children: &[Node],
    env: &[(&str, &str)],
) -> Result<String, GitError> {
    if children.is_empty() {
        return Ok(tree.to_owned());
    }
    checked(
        port,
        Command::new(root, &["read-tree", tree])
            .writing()
            .with_env(env),
    )
    .await?;
    let paths: Vec<String> = children.iter().map(|child| child.path.clone()).collect();
    remove_index_subtrees(port, root, &paths, env).await?;
    hash(&text_output(
        &checked(
            port,
            Command::new(root, &["write-tree"]).writing().with_env(env),
        )
        .await?
        .stdout,
    )?)
}

/// `subtree`: one child's entry in a tree, or the empty tree when the target has none.
async fn subtree(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    root: &str,
    tree: &str,
    path: &str,
) -> Result<String, GitError> {
    let entries = parse_tree(
        &checked(
            port,
            Command::owned(
                root,
                vec![
                    String::from("ls-tree"),
                    String::from("-z"),
                    tree.to_owned(),
                    String::from("--"),
                    format!(":(literal){path}"),
                ],
            ),
        )
        .await?
        .stdout,
    )?;
    if entries.is_empty() {
        let index = TemporaryIndex::create(&context.temp_directory)?;
        let env = env_pairs(index.env());
        checked(
            port,
            Command::new(root, &["read-tree", "--empty"])
                .writing()
                .with_env(&env),
        )
        .await?;
        return hash(&text_output(
            &checked(
                port,
                Command::new(root, &["write-tree"]).writing().with_env(&env),
            )
            .await?
            .stdout,
        )?);
    }
    let Some(entry) = entries.first() else {
        return Err(malformed("nested restore subtree"));
    };
    if entries.len() != 1 || entry.path != path || entry.kind != "tree" {
        return Err(malformed("nested restore subtree"));
    }
    Ok(entry.sha.clone())
}

#[cfg(test)]
mod tests;
