// SPDX-License-Identifier: Apache-2.0
//! What a lease's recorded root is now, read from the filesystem without
//! launching Git, and the repository a journal belongs to
//! (`packages/git/src/lease-roots.ts`).

use std::path::Path;

use crate::core::error::GitError;
use crate::core::lease::journal::{journal, metadata_directory, text};
use crate::core::lease::missing;
use crate::core::lease::state::RootKind;
use crate::core::paths::{canonical, resolve};

fn canonical_or_none(path: &str) -> Result<Option<String>, GitError> {
    match canonical(path) {
        Ok(path) => Ok(Some(path)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(GitError::from_io(&error)),
    }
}

/// What a lease's recorded root is now: gone, unregistered, linked or other.
/// Unreadable or malformed metadata counts as `other`, which keeps the fence.
pub fn root_kind(root: &str, directory: &str) -> RootKind {
    if let Err(error) = std::fs::symlink_metadata(root) {
        return if missing(&error) {
            RootKind::Gone
        } else {
            RootKind::Other
        };
    }
    match root_kind_inner(root, directory) {
        Ok(kind) => kind,
        Err(_) => RootKind::Other,
    }
}

fn root_kind_inner(root: &str, directory: &str) -> Result<RootKind, GitError> {
    let Some(metadata) = metadata_directory(root)? else {
        return Ok(RootKind::Other);
    };
    let dot = Path::new(root).join(".git");
    if std::fs::symlink_metadata(&dot).is_ok_and(|info| info.is_dir()) {
        return Ok(RootKind::Other);
    }
    let Some(resolved) = canonical_or_none(&metadata)? else {
        return Ok(RootKind::Unregistered);
    };
    let commondir = text(&Path::new(&resolved).join("commondir"))?;
    // A `.git` file without `commondir` is a submodule-style checkout: its own repository.
    if commondir.is_none() {
        return Ok(RootKind::Other);
    }
    let Some(back) = text(&Path::new(&resolved).join("gitdir"))? else {
        return Ok(RootKind::Unregistered);
    };
    let Some(registered) = canonical_or_none(&resolve(&resolved, back.trim_end_matches('\n')))?
    else {
        return Ok(RootKind::Unregistered);
    };
    let own = canonical_or_none(&dot.to_string_lossy())?;
    if own.as_deref() != Some(registered.as_str()) {
        return Ok(RootKind::Unregistered);
    }
    Ok(match journal(root)? {
        Some(own_journal) if own_journal == directory => RootKind::Linked,
        _ => RootKind::Other,
    })
}

/// The repository a journal belongs to, as a person would name it: its main
/// checkout's path, or the lease's own root for a standalone journal.
pub fn journal_repository(directory: &str, root: &str) -> String {
    let path = Path::new(directory);
    let metadata = path.parent().unwrap_or(path);
    let name = metadata
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name == ".ace-git-mutation-leases" {
        return root.to_owned();
    }
    if name == ".git" {
        return metadata
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    metadata.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> String {
        let path =
            std::env::temp_dir().join(format!("ace-g2b-roots-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("scratch");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_missing_root_is_gone_and_a_plain_repository_is_other() {
        assert_eq!(
            root_kind("/nonexistent/ace-g2b/root", "/tmp"),
            RootKind::Gone
        );
        let main = scratch("main");
        fs::create_dir_all(Path::new(&main).join(".git")).expect("git dir");
        let kind = root_kind(&main, &format!("{main}/.git/ace-mutation-leases"));
        assert_eq!(kind, RootKind::Other);
        fs::remove_dir_all(&main).expect("cleanup");
    }

    #[test]
    fn a_linked_worktree_whose_journal_is_this_directory_is_linked() {
        let main = scratch("linked-main");
        let common = Path::new(&main).join(".git");
        let worktree = scratch("linked-worktree");
        let metadata = common.join("worktrees").join("wt");
        fs::create_dir_all(&metadata).expect("metadata");
        fs::write(
            Path::new(&worktree).join(".git"),
            format!("gitdir: {}\n", metadata.display()),
        )
        .expect("git file");
        fs::write(metadata.join("gitdir"), format!("{worktree}/.git\n")).expect("back");
        fs::write(metadata.join("commondir"), "../..\n").expect("common");
        let journal = journal(&worktree).expect("journal").expect("some");
        assert_eq!(root_kind(&worktree, &journal), RootKind::Linked);
        // A pruned registration is unregistered, never linked.
        fs::remove_file(metadata.join("gitdir")).expect("prune");
        assert_eq!(root_kind(&worktree, &journal), RootKind::Unregistered);
        for path in [main, worktree] {
            let _ = fs::remove_dir_all(path);
        }
    }

    #[test]
    fn the_repository_of_a_journal_is_its_main_checkout_or_the_leases_root() {
        assert_eq!(
            journal_repository("/repos/ace/.git/ace-mutation-leases", "/repos/ace/x"),
            "/repos/ace"
        );
        assert_eq!(
            journal_repository("/tmp/.ace-git-mutation-leases/abc", "/tmp/new-repo"),
            "/tmp/new-repo"
        );
        assert_eq!(
            journal_repository(
                "/repos/ace/.git/worktrees/x/ace-mutation-leases",
                "/repos/x"
            ),
            "/repos/ace/.git/worktrees/x"
        );
    }
}
