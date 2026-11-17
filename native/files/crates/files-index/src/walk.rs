// SPDX-License-Identifier: Apache-2.0

//! The parallel walk behind a build and behind a created-folder update.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use files_safe::Root;
use ignore::overrides::{Override, OverrideBuilder};
use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};

use crate::error::Error;

/// What the walk must leave out: git-ignore rules unless asked otherwise, and glob patterns that
/// never list.
#[derive(Debug, Clone)]
pub(crate) struct Filters {
    include_ignored: bool,
    matcher: Override,
}

impl Default for Filters {
    fn default() -> Filters {
        Filters {
            include_ignored: false,
            matcher: Override::empty(),
        }
    }
}

impl Filters {
    /// Validate the hide patterns once, so a bad glob fails the build instead of silently hiding
    /// nothing.
    pub fn new(root: &Root, hide: &[String], include_ignored: bool) -> Result<Filters, Error> {
        let mut cleaned = Vec::with_capacity(hide.len());
        for pattern in hide {
            let pattern = pattern.trim();
            if pattern.is_empty() {
                continue;
            }
            if pattern.starts_with('!') {
                return Err(Error::InvalidArgument(format!(
                    "a hide pattern cannot start with '!': {pattern}"
                )));
            }
            cleaned.push(pattern.to_owned());
        }
        Ok(Filters {
            matcher: matcher(root, &cleaned)?,
            include_ignored,
        })
    }

    /// Whether a single relative path is hidden, for paths the watcher reports directly rather than
    /// through a walk.
    pub fn hides(&self, root: &Root, path: &str) -> bool {
        self.matcher
            .matched(root.path().join(path), false)
            .is_ignore()
    }
}

/// The files found by one walk.
pub(crate) struct Collected {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Walk `start` under `root` and collect every file, up to `max_files`.
///
/// Hidden files are included, because a person can open a dotfile. Nothing inside a `.git` folder is
/// ever indexed, at any depth or as the root itself: that store is never a quick-open target and
/// would fill any cap on its own.
///
/// Git's rules are applied as git applies them. A root inside a repository also sees the
/// `.gitignore` files and `.git/info/exclude` from the repository top down, and nothing above that
/// top. A root outside any repository applies the `.gitignore` files from itself and its parent
/// folders, since there is no repository top to stop the chain.
pub(crate) fn collect(
    root: &Root,
    filters: &Filters,
    max_files: usize,
    cancel: &AtomicBool,
    start: &Path,
) -> Result<Collected, Error> {
    if inside_git_store(root) {
        return Ok(Collected {
            paths: Vec::new(),
            truncated: false,
        });
    }
    let in_repo = repo_top(root.path()).is_some();
    let mut builder = WalkBuilder::new(start);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(true)
        .require_git(in_repo)
        .ignore(!filters.include_ignored)
        .git_ignore(!filters.include_ignored)
        .git_global(!filters.include_ignored)
        .git_exclude(!filters.include_ignored)
        .threads(rayon::current_num_threads().max(1))
        .overrides(filters.matcher.clone());
    let shared = Shared {
        root,
        paths: Mutex::new(Vec::new()),
        count: AtomicUsize::new(0),
        cap_hit: AtomicBool::new(false),
        max_files,
        cancel,
    };
    builder
        .build_parallel()
        .visit(&mut CollectBuilder { shared: &shared });
    let paths = match shared.paths.into_inner() {
        Ok(paths) => paths,
        Err(poisoned) => poisoned.into_inner(),
    };
    Ok(Collected {
        paths,
        truncated: shared.cap_hit.load(Ordering::Relaxed),
    })
}

/// Hide patterns are override globs whose meaning is inverted: `!target` means "never list".
fn matcher(root: &Root, hide: &[String]) -> Result<Override, Error> {
    let mut builder = OverrideBuilder::new(root.path());
    builder.add("!.git")?;
    for pattern in hide {
        builder.add(&format!("!{pattern}"))?;
    }
    Ok(builder.build()?)
}

/// The nearest folder at or above `start` that holds a `.git` entry.
fn repo_top(start: &Path) -> Option<&Path> {
    start.ancestors().find(|dir| dir.join(".git").exists())
}

/// A root inside the git store of a repository: every path under it lives in a `.git` folder, so
/// none of them is ever indexed.
fn inside_git_store(root: &Root) -> bool {
    root.path()
        .ancestors()
        .any(|dir| dir.file_name().is_some_and(|name| name == ".git"))
}

struct Shared<'a> {
    root: &'a Root,
    paths: Mutex<Vec<String>>,
    count: AtomicUsize,
    cap_hit: AtomicBool,
    max_files: usize,
    cancel: &'a AtomicBool,
}

struct CollectBuilder<'a> {
    shared: &'a Shared<'a>,
}

impl<'s> ParallelVisitorBuilder<'s> for CollectBuilder<'s> {
    fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
        Box::new(CollectVisitor {
            shared: self.shared,
            local: Vec::with_capacity(1024),
        })
    }
}

/// Each walk thread fills its own buffer and hands it over when the thread finishes, so a million
/// paths cost one lock per thread rather than one per file.
struct CollectVisitor<'a> {
    shared: &'a Shared<'a>,
    local: Vec<String>,
}

impl ParallelVisitor for CollectVisitor<'_> {
    fn visit(&mut self, entry: Result<DirEntry, ignore::Error>) -> WalkState {
        if self.shared.cancel.load(Ordering::Relaxed) {
            return WalkState::Quit;
        }
        let Ok(entry) = entry else {
            return WalkState::Continue;
        };
        if entry.file_type().is_none_or(|kind| !kind.is_file()) {
            return WalkState::Continue;
        }
        let Some(path) = self.shared.root.relative(entry.path()) else {
            return WalkState::Continue;
        };
        if path.is_empty() {
            return WalkState::Continue;
        }
        if self.shared.count.fetch_add(1, Ordering::Relaxed) >= self.shared.max_files {
            self.shared.cap_hit.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        self.local.push(path);
        WalkState::Continue
    }
}

impl Drop for CollectVisitor<'_> {
    fn drop(&mut self) {
        if self.local.is_empty() {
            return;
        }
        let mut paths = match self.shared.paths.lock() {
            Ok(paths) => paths,
            Err(poisoned) => poisoned.into_inner(),
        };
        paths.append(&mut self.local);
    }
}
