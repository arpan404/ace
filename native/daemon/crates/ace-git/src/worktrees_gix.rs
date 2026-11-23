// SPDX-License-Identifier: Apache-2.0
//! The worktree-list half of the ref reads (G1): the records `worktree list --porcelain -z`
//! prints, which the caller decodes with `parseWorktrees` (absolute paths included).
//!
//! A prunable worktree, or a locked one whose reason `gix` doesn't word as the `locked` file
//! does, falls back so Git prints it: its wording is Git's and only Git's.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use gix::bstr::{BString, ByteSlice};
use gix::refs::TargetRef;

use crate::refs::{Fallback, Outcome, open, reftable};

/// The `worktree list --porcelain -z` bytes.
pub fn worktrees(root: &str) -> Outcome<Vec<u8>> {
    let Some(repo) = open(root) else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    if reftable(&repo) {
        return Outcome::fallback(Fallback::Reftable);
    }
    let Ok(main) = repo.main_repo() else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    let zeros = "0".repeat(main.object_hash().len_in_hex());
    let ignore_case = main
        .config_snapshot()
        .boolean("core.ignorecase")
        .unwrap_or(false);
    let mut entries = Vec::new();
    let main_path = main.workdir().unwrap_or(main.git_dir()).to_path_buf();
    let Ok(entry) = main_entry(&main, main_path, &zeros) else {
        return Outcome::fallback(Fallback::WorktreeReason);
    };
    entries.push(entry);
    let Ok(proxies) = main.worktrees() else {
        return Outcome::fallback(Fallback::Unreadable);
    };
    for proxy in proxies {
        // Git's own list spells a prunable worktree with a reason of its own wording.
        if proxy.is_prunable() {
            return Outcome::fallback(Fallback::WorktreeReason);
        }
        let Ok(path) = proxy.base() else {
            return Outcome::fallback(Fallback::WorktreeReason);
        };
        let locked = match locked(&proxy) {
            Ok(locked) => locked,
            Err(()) => return Outcome::fallback(Fallback::WorktreeReason),
        };
        let Ok(worktree) = proxy.into_repo_with_possibly_inaccessible_worktree() else {
            return Outcome::fallback(Fallback::WorktreeReason);
        };
        let Ok(mut entry) = main_entry(&worktree, path, &zeros) else {
            return Outcome::fallback(Fallback::WorktreeReason);
        };
        entry.locked = locked;
        entries.push(entry);
    }
    // The main worktree first, then the linked ones by path (`fspathcmp`).
    let (main, linked) = entries.split_at_mut(1);
    linked.sort_by(|a, b| compare(&a.path, &b.path, ignore_case));
    let mut out = Vec::new();
    for entry in main.iter().chain(linked.iter()) {
        encode(entry, &mut out);
    }
    Outcome::data(out)
}

/// One worktree record's fields, in the order `parseWorktrees` expects them.
struct Entry {
    path: Vec<u8>,
    head: String,
    branch: Option<BString>,
    detached: bool,
    bare: bool,
    locked: Option<BString>,
}

/// A worktree's checkout, HEAD and branch, or `None` when `gix` can't read them.
fn main_entry(repo: &gix::Repository, path: PathBuf, zeros: &str) -> Result<Entry, ()> {
    let bare = repo.is_bare();
    if bare {
        return Ok(Entry {
            path: path_bytes(&path),
            head: zeros.to_owned(),
            branch: None,
            detached: false,
            bare,
            locked: None,
        });
    }
    let head = repo.head().map_err(|_| ())?;
    let branch = head.referent_name().map(|name| name.as_bstr().to_owned());
    let detached = head.is_detached();
    let direct = head.id().map(|id| id.to_string());
    // HEAD prints its referent's stored object, unpeeled: `resolve_ref_unsafe("HEAD")`.
    let head = match head.try_into_referent() {
        Some(reference) => match reference.target() {
            TargetRef::Object(id) => id.to_string(),
            TargetRef::Symbolic(_) => zeros.to_owned(),
        },
        None => direct.unwrap_or_else(|| zeros.to_owned()),
    };
    Ok(Entry {
        path: path_bytes(&path),
        head,
        branch,
        detached,
        bare,
        locked: None,
    })
}

/// The reason Git prints after `locked`, or `None` when the worktree isn't locked.
fn locked(proxy: &gix::worktree::Proxy<'_>) -> Result<Option<BString>, ()> {
    if !proxy.is_locked() {
        return Ok(None);
    }
    let bytes = std::fs::read(proxy.git_dir().join("locked")).map_err(|_| ())?;
    let text = bytes.as_slice().trim();
    // `gix`'s reason must be the file's text, or Git's wording is the one that prints.
    match proxy.lock_reason() {
        Some(reason) if reason.as_bstr() == text => Ok(Some(text.into())),
        _ => Err(()),
    }
}

/// The NUL-framed records of one worktree, terminated by the empty record that ends it.
fn encode(entry: &Entry, out: &mut Vec<u8>) {
    out.extend_from_slice(b"worktree ");
    out.extend_from_slice(&entry.path);
    out.push(0);
    if entry.bare {
        out.extend_from_slice(b"bare");
        out.push(0);
    } else {
        out.extend_from_slice(b"HEAD ");
        out.extend_from_slice(entry.head.as_bytes());
        out.push(0);
        if let Some(branch) = &entry.branch {
            out.extend_from_slice(b"branch ");
            out.extend_from_slice(branch);
            out.push(0);
        }
        if entry.detached {
            out.extend_from_slice(b"detached");
            out.push(0);
        }
    }
    if let Some(reason) = &entry.locked {
        out.extend_from_slice(b"locked");
        if !reason.is_empty() {
            out.push(b' ');
            out.extend_from_slice(reason);
        }
        out.push(0);
    }
    out.push(0);
}

/// A checkout path as the bytes Git prints: raw on POSIX, forward-slashed on Windows.
#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().replace('\\', "/").into_bytes()
}

/// `fspathcmp`: byte order, or ASCII case-insensitive when `core.ignorecase` is set.
fn compare(a: &[u8], b: &[u8], ignore_case: bool) -> Ordering {
    if ignore_case {
        a.iter()
            .map(|byte| byte.to_ascii_lowercase())
            .cmp(b.iter().map(|byte| byte.to_ascii_lowercase()))
    } else {
        a.cmp(b)
    }
}
