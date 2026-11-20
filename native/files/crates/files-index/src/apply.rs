// SPDX-License-Identifier: Apache-2.0

//! Live updates from the watcher.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

use files_safe::Root;

use crate::membership::Membership;
use crate::walk::{self, Filters, Folders, Walk};
use crate::{IndexChange, PathIndex, Prepared};

/// Compaction only pays off once the holes are this many, or half the index, whichever is larger.
const COMPACT_FLOOR: usize = 65_536;

/// Expand a batch without touching the index. Created folders are walked here, which is the only
/// slow part; the caller can do it while other threads keep searching.
///
/// The batch judges each folder once and remembers the verdict, so applying twenty thousand files
/// costs one rules lookup per file rather than one per ancestor of every file.
pub(crate) fn prepare(index: &PathIndex, root: &Root, changes: &[IndexChange]) -> Prepared {
    let filters = index.filters.refreshed(root);
    let mut folders = Folders::default();
    let mut prepared = Prepared::default();
    for change in changes {
        if change.deleted {
            if !change.path.is_empty() && Root::check(&change.path).is_ok() {
                prepared.deletes.push(change.path.clone());
            }
        } else if change.directory {
            add_subtree(
                index,
                &filters,
                &mut folders,
                root,
                &change.path,
                &mut prepared,
            );
        } else {
            add_file(
                index,
                &filters,
                &mut folders,
                root,
                &change.path,
                &mut prepared,
            );
        }
    }
    prepared
}

/// Drop every deleted path and its subtree, then add the new paths.
///
/// A deleted file costs one lookup: the index holds it under its own path and holds no folder of
/// that name, so nothing below it can be indexed. Anything else (a folder, a path the index holds
/// as both, or one it does not hold at all, whose subtree may still be there) is dropped in one
/// pass over the slots together with the batch's other such paths.
pub(crate) fn commit(index: &mut PathIndex, prepared: Prepared) {
    let mut subtrees: Vec<&str> = Vec::new();
    for path in &prepared.deletes {
        if index
            .members
            .find(&index.arena, &format!("{path}/"))
            .is_none()
            && let Some(slot) = index.members.find(&index.arena, path)
        {
            index.members.remove(&index.arena, path);
            index.arena.remove(slot);
        } else {
            subtrees.push(path);
        }
    }
    if !subtrees.is_empty() {
        drop_subtrees(index, &subtrees);
    }
    for path in &prepared.adds {
        if index.arena.live_len() >= index.max_files {
            index.truncated = true;
            break;
        }
        if !crate::insert(&mut index.arena, &mut index.members, path) {
            index.truncated = true;
            break;
        }
    }
    if prepared.truncated {
        index.truncated = true;
    }
    if index.truncated && index.arena.live_len() < index.max_files {
        index.truncated = false;
    }
    if index.arena.dead_len() > index.arena.live_len().max(COMPACT_FLOOR) {
        index.arena.compact();
        reindex(index);
    }
}

/// Up to this many deleted folders are matched against each path directly; past it each path's
/// ancestors are looked up in a set instead.
const DIRECT_MATCH: usize = 8;

/// Drops each path in `deleted` and everything below it, in one pass over the slots.
fn drop_subtrees(index: &mut PathIndex, deleted: &[&str]) {
    let set: HashSet<&str> = if deleted.len() > DIRECT_MATCH {
        deleted.iter().copied().collect()
    } else {
        HashSet::new()
    };
    let doomed_path = |path: &str| {
        if set.is_empty() {
            deleted.iter().any(|folder| at_or_under(path, folder))
        } else {
            set.contains(path) || under_deleted(path, &set)
        }
    };
    let mut doomed = Vec::new();
    for slot in 0..index.arena.slots() {
        if index.arena.is_live(slot)
            && let Some(path) = index.arena.get(slot)
            && doomed_path(path)
        {
            doomed.push(slot);
        }
    }
    for slot in doomed {
        if let Some(path) = index.arena.get(slot).map(str::to_owned) {
            index.members.remove(&index.arena, &path);
            index.arena.remove(slot);
        }
    }
}

/// Whether `path` is `folder` itself, its folder entry (`folder/`), or anything below it.
fn at_or_under(path: &str, folder: &str) -> bool {
    path.strip_prefix(folder)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// Compacting renumbers slots, so the membership map has to be rebuilt from the arena.
fn reindex(index: &mut PathIndex) {
    let mut members = Membership::with_capacity(index.arena.live_len());
    for slot in 0..index.arena.slots() {
        if index.arena.is_live(slot)
            && let Some(path) = index.arena.get(slot)
        {
            members.insert(&index.arena, path, slot);
        }
    }
    index.members = members;
}

/// A watcher reports a save as a created change, so an already indexed path is refreshed in place
/// rather than added twice.
fn add_file<'a>(
    index: &PathIndex,
    filters: &Filters,
    folders: &mut Folders<'a>,
    root: &Root,
    path: &'a str,
    prepared: &mut Prepared,
) {
    if path.is_empty() || Root::check(path).is_err() || in_git_store(path) {
        return;
    }
    if filters.excludes_in(root, folders, path, false) {
        return;
    }
    if index.arena.live_len() + prepared.adds.len() >= index.max_files {
        prepared.truncated = true;
        return;
    }
    prepared.adds.push(path.to_owned());
}

fn add_subtree<'a>(
    index: &PathIndex,
    filters: &Filters,
    folders: &mut Folders<'a>,
    root: &Root,
    dir: &'a str,
    prepared: &mut Prepared,
) {
    if dir.is_empty() || in_git_store(dir) {
        return;
    }
    // The walk never filters the folder it starts from, so the created folder itself is checked
    // here, against its own name and every ancestor.
    if filters.excludes_in(root, folders, dir, true) {
        return;
    }
    let Ok(absolute) = root.resolve(dir) else {
        return;
    };
    let remaining = index
        .max_files
        .saturating_sub(index.arena.live_len() + prepared.adds.len());
    if remaining == 0 {
        prepared.truncated = true;
        return;
    }
    let cancel = AtomicBool::new(false);
    let Ok(collected) = walk::run(Walk {
        root,
        filters,
        max_files: remaining,
        cancel: &cancel,
        start: &absolute,
        recheck: true,
        progress: None,
    }) else {
        return;
    };
    if collected.truncated {
        prepared.truncated = true;
    }
    // The walk starts at the folder and reports what is inside it; the folder itself is a
    // candidate too, so `@` can offer it.
    if index.arena.live_len() + prepared.adds.len() < index.max_files {
        prepared.adds.push(format!("{dir}/"));
    } else {
        prepared.truncated = true;
    }
    prepared.adds.extend(collected.paths);
}

/// Whether a path sits below one of the deleted paths. A watcher does not always mark a deleted
/// folder as a folder, so a batch drops the exact path and its subtree either way.
fn under_deleted(path: &str, deleted: &HashSet<&str>) -> bool {
    path.match_indices('/')
        .any(|(index, _)| deleted.contains(&path[..index]))
}

/// Nothing inside a `.git` folder is ever indexed, whatever route it arrives by.
fn in_git_store(path: &str) -> bool {
    path.split('/').any(|part| part == ".git")
}
