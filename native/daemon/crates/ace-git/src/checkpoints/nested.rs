// SPDX-License-Identifier: Apache-2.0
//! Nested checkouts (`packages/git/src/nested.ts`, G5): discovery of the repositories a
//! snapshot owns, linked worktrees it leaves out, and the flattening that replaces each nested
//! directory with a gitlink into a tree the parent holds.
//!
//! A repository owns discovery below its root, so only the top-most nested roots are returned:
//! deeper ones would be snapshotted twice and their locks acquired out of hierarchy order.

use std::collections::HashSet;
use std::path::Path;

use crate::core::decode::{malformed, nul, path_ancestors, path_schema};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::core::spawn::BoxFuture;
use crate::parse::index::{IndexEntry, parse_index, parse_tree, remove_index_subtrees};
use crate::reads::worktree_facts::same_repository_worktrees;
use crate::reads::{Command, CommandPort, checked, text_output};

/// Nested repositories a snapshot owns, at most this many per root.
pub const NESTED_LIMIT: usize = 256;

/// Checkouts below `root` with their own `.git`: nested repositories, which a snapshot
/// captures, and linked worktrees of `root`'s own repository, which it leaves out entirely.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Nested {
    pub repositories: Vec<String>,
    pub linked: Vec<String>,
}

/// The children a restore owns below one root, keyed by the root's absolute path.
pub type Ownership = indexmap::IndexMap<String, Vec<String>>;

/// `ownedChildren`: the root's children, or a refusal for a root the ownership does not know.
pub fn owned_children<'a>(ownership: &'a Ownership, root: &str) -> Result<&'a [String], GitError> {
    match ownership.get(root) {
        Some(children) => Ok(children),
        None => Err(gitlinks_error("Snapshot root is outside restore ownership")),
    }
}

fn gitlinks_error(message: &str) -> GitError {
    GitError::new(GitErrorCode::UnsupportedRepository, message)
}

/// The gitlink refusal the snapshot raises twice: after removing them, and again before the
/// tree is written.
pub fn gitlinks_unsupported() -> GitError {
    gitlinks_error("Full working-tree snapshots cannot include submodules or embedded repositories")
}

/// `nestedCheckouts`: the nested roots and the linked worktrees among them.
pub async fn nested_checkouts(
    port: &dyn CommandPort,
    root: &str,
    tracked: &[IndexEntry],
    env: &[(&str, &str)],
) -> Result<Nested, GitError> {
    let found = candidate_paths(port, root, tracked, env).await?;
    let linked = same_repository_worktrees(root, &found)?;
    let repositories: Vec<String> = found
        .iter()
        .filter(|path| !linked.contains(*path))
        .cloned()
        .collect();
    if repositories.len() > NESTED_LIMIT {
        return Err(gitlinks_error(&format!(
            "More than {NESTED_LIMIT} nested repositories in one checkout"
        )));
    }
    let linked: Vec<String> = found
        .into_iter()
        .filter(|path| linked.contains(path))
        .collect();
    Ok(Nested {
        repositories,
        linked,
    })
}

/// `nestedPaths`: only the repositories.
pub async fn nested_paths(
    port: &dyn CommandPort,
    root: &str,
    tracked: &[IndexEntry],
    env: &[(&str, &str)],
) -> Result<Vec<String>, GitError> {
    Ok(nested_checkouts(port, root, tracked, env)
        .await?
        .repositories)
}

/// Every candidate that may be a nested root: the gitlinks, each tracked path's ancestors, and
/// each untracked record and its directory's ancestors.
async fn candidate_paths(
    port: &dyn CommandPort,
    root: &str,
    tracked: &[IndexEntry],
    env: &[(&str, &str)],
) -> Result<Vec<String>, GitError> {
    let mut candidates: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for entry in tracked {
        if entry.mode == "160000" {
            candidates.insert(entry.path.clone());
        }
    }
    for entry in tracked {
        // A tracked file can now be a repository directory. Check the path itself without
        // asking Git to run parent clean filters via `--modified`.
        for ancestor in path_ancestors(&entry.path) {
            candidates.insert(ancestor);
        }
    }
    let untracked = checked(
        port,
        Command::new(root, &["ls-files", "--others", "--exclude-standard", "-z"]).with_env(env),
    )
    .await?;
    for record in nul(&untracked.stdout)? {
        let path = path_schema(if record.ends_with('/') {
            &record[..record.len() - 1]
        } else {
            &record
        })
        .ok_or_else(|| malformed("untracked path"))?;
        candidates.insert(path.clone());
        let directory = if record.ends_with('/') {
            path.clone()
        } else {
            path.rfind('/')
                .map_or_else(String::new, |slash| path[..slash].to_owned())
        };
        if !directory.is_empty() {
            for ancestor in path_ancestors(&directory) {
                candidates.insert(ancestor);
            }
        }
    }
    repository_paths(root, candidates.into_iter().collect())
}

/// `repositoryPaths`: the candidates with a `.git` entry, sorted by JavaScript's string order,
/// keeping only the top-most ones.
pub fn repository_paths(root: &str, candidates: Vec<String>) -> Result<Vec<String>, GitError> {
    let mut nested: Vec<String> = Vec::new();
    for path in candidates {
        match std::fs::symlink_metadata(Path::new(root).join(&path).join(".git")) {
            Ok(_) => nested.push(path),
            // A path that is not a directory, or has no `.git`, is not a repository.
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ENOTDIR) => {}
            Err(error) => {
                return Err(GitError::filesystem(
                    error.raw_os_error().unwrap_or(0).to_string(),
                    error.to_string(),
                ));
            }
        }
    }
    nested.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let roots: HashSet<String> = nested.iter().cloned().collect();
    Ok(nested
        .into_iter()
        .filter(|path| {
            let ancestors = path_ancestors(path);
            !ancestors[..ancestors.len() - 1]
                .iter()
                .any(|ancestor| roots.contains(ancestor))
        })
        .collect())
}

/// `nestedRoot`: the nested checkout's real path, which must be that repository's own root.
pub async fn nested_root(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
) -> Result<String, GitError> {
    let nested = std::fs::canonicalize(Path::new(root).join(path)).map_err(|error| {
        GitError::filesystem(
            error.raw_os_error().unwrap_or(0).to_string(),
            error.to_string(),
        )
    })?;
    let nested = nested.to_string_lossy().into_owned();
    let prefix = text_output(
        &checked(port, Command::new(&nested, &["rev-parse", "--show-prefix"]))
            .await?
            .stdout,
    )?;
    if !prefix.is_empty() {
        return Err(GitError::new(
            GitErrorCode::NotARepo,
            "Nested path is not a repository root",
        ));
    }
    if relative(root, &nested) != path {
        return Err(gitlinks_error(
            "Nested repository must have its own working root",
        ));
    }
    Ok(nested)
}

/// `path.relative(root, nested)` with `/` separators, lexically.
fn relative(root: &str, nested: &str) -> String {
    let root = paths::normalise(Path::new(root));
    let nested = paths::normalise(Path::new(nested));
    let root = root.trim_end_matches('/');
    if nested == root {
        return String::new();
    }
    let root_parts: Vec<&str> = root.split('/').filter(|part| !part.is_empty()).collect();
    let nested_parts: Vec<&str> = nested.split('/').filter(|part| !part.is_empty()).collect();
    let common = root_parts
        .iter()
        .zip(nested_parts.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<&str> = std::iter::repeat_n("..", root_parts.len() - common).collect();
    parts.extend(&nested_parts[common..]);
    parts.join("/")
}

/// How one nested checkout is captured: through the caller's lease, or directly when the
/// caller already holds its root (`flattenNested`'s `snapshot` callback).
pub trait Capture: Sync {
    fn capture<'a>(&'a self, root: &'a str) -> BoxFuture<'a, Result<String, GitError>>;
}

/// `flattenNested`: each nested root is snapshotted, its tree transferred into `root`'s object
/// database, and its entries re-added under the gitlink path.
pub async fn flatten_nested(
    port: &dyn CommandPort,
    root: &str,
    nested: &[String],
    env: &[(&str, &str)],
    capture: &dyn Capture,
    now: &(dyn Fn() -> String + Sync),
) -> Result<(), GitError> {
    remove_index_subtrees(port, root, nested, env).await?;
    for path in nested {
        let nested = nested_root(port, root, path).await?;
        let tree = capture.capture(&nested).await?;
        crate::core::objects::transfer_tree(port, &nested, root, &tree, &now()).await?;
        let entries = parse_tree(
            &checked(
                port,
                Command::new(root, &["ls-tree", "-r", "-z", &tree]).with_env(env),
            )
            .await?
            .stdout,
        )?;
        let mut input = format!("0 {}\t{path}\0", "0".repeat(tree.len()));
        for entry in entries {
            input.push_str(&format!(
                "{} {} 0\t{path}/{}\0",
                entry.mode, entry.sha, entry.path
            ));
        }
        checked(
            port,
            Command::new(root, &["update-index", "-z", "--index-info"])
                .with_env(env)
                .writing()
                .with_input(input.as_bytes()),
        )
        .await?;
    }
    Ok(())
}

/// `ignoredPaths`: what a checkout's ignore rules hide, with every nested repository's own
/// ignored paths under it (read with no temporary-index environment) and `.git` itself.
pub async fn ignored_paths(
    port: &dyn CommandPort,
    root: &str,
    env: &[(&str, &str)],
    ownership: Option<&Ownership>,
) -> Result<Vec<String>, GitError> {
    let mut ignored = direct_ignored(port, root, env).await?;
    let nested = match ownership {
        Some(ownership) => owned_children(ownership, root)?.to_vec(),
        None => {
            let tracked = checked(port, Command::new(root, &["ls-files", "--stage", "-z"])).await?;
            nested_paths(port, root, &parse_index(&tracked.stdout)?, &[]).await?
        }
    };
    for path in nested {
        // Administrative data is excluded from snapshots and must never be replaced.
        ignored.push(format!("{path}/.git"));
        let child_root = Path::new(root).join(&path).to_string_lossy().into_owned();
        for child in ignored_paths_boxed(port, &child_root, &[], ownership).await? {
            ignored.push(format!("{path}/{child}"));
        }
    }
    Ok(ignored)
}

fn ignored_paths_boxed<'a>(
    port: &'a dyn CommandPort,
    root: &'a str,
    env: &'a [(&'a str, &'a str)],
    ownership: Option<&'a Ownership>,
) -> BoxFuture<'a, Result<Vec<String>, GitError>> {
    Box::pin(ignored_paths(port, root, env, ownership))
}

async fn direct_ignored(
    port: &dyn CommandPort,
    root: &str,
    env: &[(&str, &str)],
) -> Result<Vec<String>, GitError> {
    let output = checked(
        port,
        Command::new(
            root,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        )
        .with_env(env),
    )
    .await?;
    let mut ignored = Vec::new();
    for record in nul(&output.stdout)? {
        let path = path_schema(if record.ends_with('/') {
            &record[..record.len() - 1]
        } else {
            &record
        })
        .ok_or_else(|| malformed("ignored path"))?;
        ignored.push(path);
    }
    Ok(ignored)
}

/// `assertNoGitlinks`: a tree that still names a submodule or embedded repository.
pub async fn assert_no_gitlinks(
    port: &dyn CommandPort,
    root: &str,
    tree: &str,
) -> Result<(), GitError> {
    let entries = parse_tree(
        &checked(port, Command::new(root, &["ls-tree", "-r", "-z", tree]))
            .await?
            .stdout,
    )?;
    if entries.iter().any(|entry| entry.mode == "160000") {
        return Err(gitlinks_unsupported());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
