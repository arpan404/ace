// SPDX-License-Identifier: Apache-2.0

//! Live updates from the watcher.

use std::sync::atomic::AtomicBool;

use files_safe::Root;

use crate::membership::Membership;
use crate::walk;
use crate::{IndexChange, PathIndex};

/// Compaction only pays off once the holes are this many, or half the index, whichever is larger.
const COMPACT_FLOOR: usize = 65_536;

pub(crate) fn apply(index: &mut PathIndex, root: &Root, changes: &[IndexChange]) {
    for change in changes {
        if change.deleted {
            if change.directory {
                remove_subtree(index, &change.path);
            } else {
                remove_file(index, &change.path);
            }
        } else if change.directory {
            add_subtree(index, root, &change.path);
        } else {
            add_file(index, root, &change.path);
        }
    }
    if index.arena.dead_len() > index.arena.live_len().max(COMPACT_FLOOR) {
        index.arena.compact();
        reindex(index);
    }
}

/// Compacting renumbers slots, so the membership map has to be rebuilt from the arena.
fn reindex(index: &mut PathIndex) {
    let mut members = Membership::with_capacity(index.arena.live_len());
    for slot in 0..index.arena.slots() {
        if index.arena.is_live(slot)
            && let Some(path) = index.arena.get(slot)
        {
            members.insert(path, slot);
        }
    }
    index.members = members;
}

/// A watcher reports a save as a created change, so an already indexed path is refreshed in place
/// rather than added twice.
fn add_file(index: &mut PathIndex, root: &Root, path: &str) {
    if path.is_empty() || Root::check(path).is_err() || in_git_store(path) {
        return;
    }
    if index.filters.hides(root, path) {
        return;
    }
    if index.arena.live_len() >= index.max_files {
        index.truncated = true;
        return;
    }
    if !crate::insert(&mut index.arena, &mut index.members, path) {
        index.truncated = true;
    }
}

fn add_subtree(index: &mut PathIndex, root: &Root, dir: &str) {
    if dir.is_empty() || in_git_store(dir) {
        return;
    }
    let Ok(absolute) = root.resolve(dir) else {
        return;
    };
    let remaining = index.max_files.saturating_sub(index.arena.live_len());
    if remaining == 0 {
        index.truncated = true;
        return;
    }
    let cancel = AtomicBool::new(false);
    let Ok(collected) = walk::collect(root, &index.filters, remaining, &cancel, &absolute) else {
        return;
    };
    if collected.truncated {
        index.truncated = true;
    }
    for path in &collected.paths {
        if !crate::insert(&mut index.arena, &mut index.members, path) {
            index.truncated = true;
            break;
        }
    }
}

fn remove_file(index: &mut PathIndex, path: &str) {
    let Some(slot) = index.members.find(&index.arena, path) else {
        return;
    };
    index.arena.remove(slot);
    index.members.remove(&index.arena, path);
}

/// A deleted folder takes every path below it with it. Only the reported folder is known, so the
/// index has to look at each path once; deletions arrive in batches, not per keystroke.
fn remove_subtree(index: &mut PathIndex, dir: &str) {
    if dir.is_empty() {
        return;
    }
    let mut doomed = Vec::new();
    for slot in 0..index.arena.slots() {
        if !index.arena.is_live(slot) {
            continue;
        }
        if let Some(path) = index.arena.get(slot)
            && is_in_dir(path, dir)
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

fn is_in_dir(path: &str, dir: &str) -> bool {
    path.len() > dir.len() && path.starts_with(dir) && path.as_bytes().get(dir.len()) == Some(&b'/')
}

/// Nothing inside a `.git` folder is ever indexed, whatever route it arrives by.
fn in_git_store(path: &str) -> bool {
    path.split('/').any(|part| part == ".git")
}
