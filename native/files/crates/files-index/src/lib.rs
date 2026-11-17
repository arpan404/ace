// SPDX-License-Identifier: Apache-2.0

//! The quick-open path index for one checkout.
//!
//! A build walks the checkout once, in parallel, with git's ignore rules, and stores every file
//! path in a single byte arena. A search matches a query against every path with the same fuzzy
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
mod membership;
mod query;
mod ranking;
mod topk;
mod walk;

pub use error::Error;

use std::sync::atomic::AtomicBool;

use files_safe::Root;

use arena::PathArena;
use membership::Membership;
use walk::Filters;

/// How much a build takes in. The defaults are what the daemon passes: a million files, git-ignore
/// rules respected, and the entries a person never opens hidden.
#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// Hard cap on indexed files. A larger checkout keeps the first files the walk finds and
    /// reports [`PathIndex::truncated`].
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
    /// cancelled build returns the files it saw before the flag went up.
    pub fn build(
        root: &Root,
        options: &IndexOptions,
        cancel: &AtomicBool,
    ) -> Result<PathIndex, Error> {
        build::build(root, options, cancel)
    }

    /// Apply a watcher batch: created and modified paths are added (or refreshed), deleted files
    /// are dropped, and a folder change is expanded or collapsed to its subtree.
    pub fn apply(&mut self, root: &Root, changes: &[IndexChange]) {
        apply::apply(self, root, changes);
    }

    /// Search for `query`, best first. An empty or all-whitespace query returns nothing. Case is
    /// ignored and the query has to appear in order, though not adjacently.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        query::search(&self.arena, query, limit)
    }

    /// Files currently indexed.
    pub fn len(&self) -> usize {
        self.arena.live_len()
    }

    /// Whether the checkout has no indexable files.
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

/// Add a path unless the same path is already indexed, so a watcher's repeated saves do not show up
/// twice. Returns whether the path is now indexed.
pub(crate) fn insert(arena: &mut PathArena, members: &mut Membership, path: &str) -> bool {
    if members.find(arena, path).is_some() {
        return true;
    }
    match arena.push(path) {
        Some(slot) => {
            members.insert(path, slot);
            true
        }
        None => false,
    }
}
