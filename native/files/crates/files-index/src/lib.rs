// SPDX-License-Identifier: Apache-2.0

//! The quick-open path index for one checkout.
//!
//! A build walks the checkout once, in parallel, with git's ignore rules, and stores every path
//! in a single byte arena: files, and folders with a trailing `/` so `@` can offer them. A search
//! matches a query against every path with the same fuzzy
//! matcher quick open uses, ranks the matches (file-name matches first, contiguous runs next,
//! shorter paths for ties), and keeps only the best `limit` through a bounded heap per parallel
//! batch.
//!
//! The index is not a snapshot: watchers report changes, and [`PathIndex::apply`] adds, refreshes
//! and removes the affected paths so quick open stays right while agents write files.
//!
//! ```no_run
//! use std::sync::atomic::AtomicBool;
//!
//! let root = files_safe::Root::open(std::path::Path::new(".")).expect("a directory");
//! let mut index = files_index::PathIndex::build(
//!     &root,
//!     &files_index::IndexOptions::default(),
//!     &AtomicBool::new(false),
//! )
//! .expect("walked");
//! let hits = index.search("mainrs", 20);
//! assert!(hits.len() <= 20);
//! ```

mod apply;
mod arena;
mod build;
mod error;
mod ignores;
mod membership;
mod query;
mod ranking;
mod topk;
mod walk;

pub use error::Error;

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use files_safe::Root;

use arena::PathArena;
use membership::Membership;
use walk::Filters;

/// How much a build takes in. The defaults are what the daemon passes: a million files, git-ignore
/// rules respected, and the entries a person never opens hidden.
#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// Hard cap on indexed paths, folders included. A larger checkout keeps the first paths the
    /// walk finds and reports [`PathIndex::truncated`].
    pub max_files: usize,
    /// Index files that git ignores. Off by default, as the Files panel dims ignored entries.
    pub include_ignored: bool,
    /// Glob patterns that never enter the index, in the same form as `files-list`'s hide list.
    pub hide: Vec<String>,
}

impl Default for IndexOptions {
    fn default() -> IndexOptions {
        IndexOptions {
            max_files: 1_000_000,
            include_ignored: false,
            hide: vec![".git".to_owned(), ".DS_Store".to_owned()],
        }
    }
}

/// One change from the watcher. A save arrives as a created change, which refreshes the path in
/// place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexChange {
    /// Relative to the root, `/` separated.
    pub path: String,
    /// The path is gone; a deleted folder takes its subtree with it.
    pub deleted: bool,
    /// The change is about a folder, which the index expands to its files.
    pub directory: bool,
}

/// One search result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// The path as it appears in the index.
    pub path: String,
    /// Higher is a better match; compare hits by this, then by path length.
    pub score: u32,
    /// Byte offsets into `path` of the matched characters, ascending, for highlighting.
    pub positions: Vec<u32>,
}

/// A watcher batch expanded into the paths a commit will add and drop, with created folders already
/// walked. Build it with [`PathIndex::prepare`] while searches are running, then hand it to
/// [`PathIndex::commit`].
#[derive(Debug, Default)]
pub struct Prepared {
    pub(crate) adds: Vec<String>,
    pub(crate) deletes: Vec<String>,
    pub(crate) truncated: bool,
}

/// Every file in one checkout, searchable as quickly as a person types.
#[derive(Debug)]
pub struct PathIndex {
    pub(crate) arena: PathArena,
    pub(crate) members: Membership,
    pub(crate) filters: Filters,
    pub(crate) max_files: usize,
    pub(crate) truncated: bool,
}

impl PathIndex {
    /// Walk the checkout and index every file in it. `cancel` is checked as the walk proceeds; a
    /// cancelled build returns [`Error::Aborted`] and no index.
    ///
    /// Git's ignore rules apply the way git applies them. A root inside a repository also sees the
    /// `.gitignore` files and `.git/info/exclude` from the repository top down, and nothing above
    /// that top. A root outside any repository sees only its own `.gitignore` files, never those of
    /// its parent folders. `.ignore` files are not git's and never apply. Nothing inside a `.git`
    /// folder is indexed, and a symlink is indexed only when it points at a file inside the root.
    pub fn build(
        root: &Root,
        options: &IndexOptions,
        cancel: &AtomicBool,
    ) -> Result<PathIndex, Error> {
        build::build(root, options, cancel, None)
    }

    /// [`PathIndex::build`] with a progress callback, called with the number of files accepted so
    /// far. Test support only; the daemon calls [`PathIndex::build`].
    #[doc(hidden)]
    pub fn build_with_progress(
        root: &Root,
        options: &IndexOptions,
        cancel: &AtomicBool,
        progress: &(dyn Fn(u64) + Sync),
    ) -> Result<PathIndex, Error> {
        build::build(root, options, cancel, Some(progress))
    }

    /// Expand a watcher batch without changing the index. Created folders are walked here, so a
    /// caller sharing the index with a search can do the slow part while searches keep running and
    /// take the write lock only for [`PathIndex::commit`].
    pub fn prepare(&self, root: &Root, changes: &[IndexChange]) -> Prepared {
        apply::prepare(self, root, changes)
    }

    /// Apply a prepared batch: every deleted path and its subtree is dropped, then the new paths are
    /// added. Truncation clears once a batch brings the index back under its cap.
    pub fn commit(&mut self, prepared: Prepared) {
        apply::commit(self, prepared);
    }

    /// [`PathIndex::prepare`] followed by [`PathIndex::commit`], for callers that are not sharing
    /// the index with a search.
    pub fn apply(&mut self, root: &Root, changes: &[IndexChange]) {
        let prepared = self.prepare(root, changes);
        self.commit(prepared);
    }

    /// This index with everything under one folder walked again, or `folder` empty to walk the
    /// whole checkout.
    ///
    /// An edited `.gitignore`, the repository's `info/exclude` or the user's global excludes file
    /// changes which paths belong in the index without touching a single file the watcher could
    /// report, so neither adding nor deleting paths is enough: the folder must be judged by the
    /// new rules. The walk happens here, on the caller's thread, while the index being served
    /// keeps answering; the caller swaps the result in when it is done, as it does a rescan.
    pub fn rebuilt_folder(
        &self,
        root: &Root,
        folder: &str,
        options: &IndexOptions,
        cancel: &AtomicBool,
    ) -> Result<PathIndex, Error> {
        let replacement = build::build_folder(root, folder, options, cancel)?;
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Aborted);
        }
        let filters = Filters::new(root, &options.hide, options.include_ignored)?;
        // Sized exactly, so the copy holds no slack: it replaces the served index for good, and a
        // byte arena grown by doubling keeps up to half its capacity unused.
        let (kept, kept_bytes) = self
            .live_paths()
            .filter(|path| !under(path, folder))
            .fold((0, 0), |(count, bytes), path| {
                (count + 1, bytes + path.len())
            });
        let mut arena = PathArena::with_capacity(
            kept + replacement.len(),
            kept_bytes + replacement.arena.text_len(),
        );
        let mut members = Membership::with_capacity(kept + replacement.len());
        let mut truncated = false;
        for slot in 0..self.arena.slots() {
            if !self.arena.is_live(slot) {
                continue;
            }
            let Some(path) = self.arena.get(slot) else {
                continue;
            };
            if under(path, folder) {
                continue;
            }
            if arena.live_len() >= self.max_files || !insert(&mut arena, &mut members, path) {
                truncated = true;
                break;
            }
        }
        if !truncated {
            for slot in 0..replacement.arena.slots() {
                if !replacement.arena.is_live(slot) {
                    continue;
                }
                let Some(path) = replacement.arena.get(slot) else {
                    continue;
                };
                if arena.live_len() >= self.max_files || !insert(&mut arena, &mut members, path) {
                    truncated = true;
                    break;
                }
            }
        }
        if replacement.truncated {
            truncated = true;
        }
        if truncated && arena.live_len() < self.max_files {
            truncated = false;
        }
        Ok(PathIndex {
            arena,
            members,
            filters,
            max_files: self.max_files,
            truncated,
        })
    }

    /// Every indexed path, in slot order.
    fn live_paths(&self) -> impl Iterator<Item = &str> {
        (0..self.arena.slots())
            .filter(|slot| self.arena.is_live(*slot))
            .filter_map(|slot| self.arena.get(slot))
    }

    /// Search for `query`, best first. An empty or all-whitespace query returns the shallowest
    /// paths, then by path, so bare `@` opens on the checkout's top-level files and folders. Case
    /// is ignored, whitespace separates terms, every term must appear in order though not
    /// adjacently, and positions are byte offsets at character boundaries. A folder is stored and
    /// returned with a trailing `/`.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        query::search(&self.arena, query, limit)
    }

    /// Paths currently indexed, folders included.
    pub fn len(&self) -> usize {
        self.arena.live_len()
    }

    /// Whether the checkout has no indexable paths.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether the build stopped at [`IndexOptions::max_files`] or at the arena's offset limit.
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Build an index straight from a list of paths, without touching the disk. Test and bench
    /// support only; the wire API never calls it.
    #[doc(hidden)]
    pub fn from_paths(paths: impl IntoIterator<Item = String>) -> PathIndex {
        let paths: Vec<String> = paths.into_iter().collect();
        let bytes = paths.iter().map(String::len).sum();
        let mut arena = PathArena::with_capacity(paths.len(), bytes);
        let mut members = Membership::with_capacity(paths.len());
        for path in &paths {
            insert(&mut arena, &mut members, path);
        }
        PathIndex {
            arena,
            members,
            filters: Filters::default(),
            max_files: usize::MAX,
            truncated: false,
        }
    }

    /// Bytes held by paths and their bookkeeping. Test and bench support only.
    #[doc(hidden)]
    pub fn bytes_used(&self) -> usize {
        self.arena.bytes_used() + self.members.bytes_used()
    }
}

/// The index is shared with searches, which take `&PathIndex` from other threads.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<PathIndex>();
};

/// Add a path unless the same path is already indexed, so a watcher's repeated saves do not show up
/// twice. Returns whether the path is now indexed.
pub(crate) fn insert(arena: &mut PathArena, members: &mut Membership, path: &str) -> bool {
    if members.find(arena, path).is_some() {
        return true;
    }
    match arena.push(path) {
        Some(slot) => {
            members.insert(arena, path, slot);
            true
        }
        None => false,
    }
}

/// Whether a path is the folder itself or sits inside it. The empty folder is the whole root.
fn under(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
}
