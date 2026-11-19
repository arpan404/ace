// SPDX-License-Identifier: Apache-2.0

//! The parallel walk behind a build and behind a created-folder update.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use files_safe::Root;
use ignore::overrides::{Override, OverrideBuilder};
use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};

use crate::error::Error;
use crate::ignores::{self, IgnoreRules};

/// What the walk must leave out: git-ignore rules unless asked otherwise, and glob patterns that
/// never list. The same value answers for paths the watcher reports directly, so a created file is
/// judged by the rules a build would use.
#[derive(Debug)]
pub(crate) struct Filters {
    include_ignored: bool,
    hide: Override,
    rules: Option<IgnoreRules>,
}

impl Default for Filters {
    fn default() -> Filters {
        Filters {
            include_ignored: false,
            hide: Override::empty(),
            rules: None,
        }
    }
}

impl Filters {
    /// Validate the hide patterns once and load the git rules, so a bad glob fails the build instead
    /// of silently hiding nothing.
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
            hide: matcher(root, &cleaned)?,
            include_ignored,
            rules: (!include_ignored).then(|| IgnoreRules::new(root)),
        })
    }

    /// The same hidden patterns with git rules read again. A watcher can create or edit a
    /// `.gitignore`, so an update must not judge new files by the rules a build loaded earlier.
    pub fn refreshed(&self, root: &Root) -> Filters {
        Filters {
            include_ignored: self.include_ignored,
            hide: self.hide.clone(),
            rules: (!self.include_ignored).then(|| IgnoreRules::new(root)),
        }
    }

    /// Whether a path the watcher reported, or any of its ancestor folders, is hidden or ignored.
    pub fn excludes(&self, root: &Root, path: &str, is_dir: bool) -> bool {
        let leaf = path.len();
        for prefix in prefixes(path) {
            let prefix_is_dir = prefix.len() < leaf || is_dir;
            if self.hides(root, prefix, prefix_is_dir) {
                return true;
            }
            if let Some(rules) = &self.rules
                && rules.ignored(&root.path().join(prefix), prefix_is_dir, false)
            {
                return true;
            }
        }
        false
    }

    /// Whether a path from a walk is excluded by rules the walk itself could not see.
    pub fn recheck(&self, root: &Root, path: &str) -> bool {
        self.rules
            .as_ref()
            .is_some_and(|rules| rules.ignored(&root.path().join(path), false, true))
    }

    /// Whether the rules above the root can exclude anything, so a walk that starts at the root
    /// needs no per-entry recheck.
    pub fn has_ancestors(&self) -> bool {
        self.rules.as_ref().is_some_and(IgnoreRules::has_ancestors)
    }

    fn hides(&self, root: &Root, path: &str, is_dir: bool) -> bool {
        self.hide
            .matched(root.path().join(path), is_dir)
            .is_ignore()
    }
}

/// Every `/`-separated prefix of a path, ending with the path itself.
fn prefixes(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/')
        .map(move |(index, _)| &path[..index])
        .chain(std::iter::once(path))
}

/// One request to walk files into a list.
pub(crate) struct Walk<'a> {
    pub root: &'a Root,
    pub filters: &'a Filters,
    pub max_files: usize,
    pub cancel: &'a AtomicBool,
    pub start: &'a Path,
    /// Whether each entry must be rechecked against the rules above the walk start. A build walking
    /// from the index root only needs this when the root sits below a repository top; walking a
    /// folder inside the root always needs it.
    pub recheck: bool,
    /// Test support: called with the number of files accepted so far.
    pub progress: Option<&'a (dyn Fn(u64) + Sync)>,
}

/// The files found by one walk.
pub(crate) struct Collected {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub cancelled: bool,
}

impl Collected {
    /// A walk that found nothing, such as one over a folder that has since vanished.
    pub fn empty() -> Collected {
        Collected {
            paths: Vec::new(),
            truncated: false,
            cancelled: false,
        }
    }
}

/// Walk `root` and collect every path, up to `max_files`.
///
/// A folder is collected as itself with a trailing `/`, so quick open can offer it beside files.
/// Hidden files are included, because a person can open a dotfile. Nothing inside a `.git` folder
/// is ever indexed, at any depth or as the root itself: that store is never a quick-open target
/// and would fill any cap on its own. Symlinks are indexed when they point at a file inside the
/// root; symlinked folders are never followed.
pub(crate) fn run(walk: Walk<'_>) -> Result<Collected, Error> {
    if inside_git_store(walk.root) {
        return Ok(Collected {
            paths: Vec::new(),
            truncated: false,
            cancelled: false,
        });
    }
    let mut builder = WalkBuilder::new(walk.start);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(false)
        .require_git(false)
        .ignore(false)
        .git_ignore(!walk.filters.include_ignored)
        .git_global(!walk.filters.include_ignored && in_repo(walk.root))
        .git_exclude(false)
        .threads(rayon::current_num_threads().max(1))
        .overrides(walk.filters.hide.clone());
    let shared = Shared {
        root: walk.root,
        filters: walk.filters,
        paths: Mutex::new(Vec::new()),
        count: AtomicUsize::new(0),
        cap_hit: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        max_files: walk.max_files,
        cancel: walk.cancel,
        recheck: walk.recheck,
        progress: walk.progress,
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
        cancelled: shared.cancelled.load(Ordering::Relaxed),
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

fn in_repo(root: &Root) -> bool {
    ignores::repo_top(root.path()).is_some()
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
    filters: &'a Filters,
    paths: Mutex<Vec<String>>,
    count: AtomicUsize,
    cap_hit: AtomicBool,
    cancelled: AtomicBool,
    max_files: usize,
    cancel: &'a AtomicBool,
    recheck: bool,
    progress: Option<&'a (dyn Fn(u64) + Sync)>,
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
            self.shared.cancelled.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        let Ok(entry) = entry else {
            return WalkState::Continue;
        };
        let Some(kind) = entry.file_type() else {
            return WalkState::Continue;
        };
        if !kind.is_file() && !kind.is_symlink() && !kind.is_dir() {
            return WalkState::Continue;
        }
        if kind.is_symlink() && !self.links_to_file(&entry) {
            return WalkState::Continue;
        }
        let Some(path) = self.shared.root.relative(entry.path()) else {
            return WalkState::Continue;
        };
        if path.is_empty() {
            return WalkState::Continue;
        }
        if self.shared.recheck && self.shared.filters.recheck(self.shared.root, &path) {
            return WalkState::Continue;
        }
        // A folder is indexed as itself, ending in `/` so it can never be mistaken for a file and
        // is offered as a folder in the `@` menu. One its own ignore rules hide is not indexed.
        let found = if kind.is_dir() {
            if self.shared.filters.excludes(self.shared.root, &path, true) {
                return WalkState::Continue;
            }
            format!("{path}/")
        } else {
            path
        };
        let seen = self.shared.count.fetch_add(1, Ordering::Relaxed);
        if seen >= self.shared.max_files {
            self.shared.cap_hit.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        if let Some(progress) = self.shared.progress {
            progress(seen as u64 + 1);
        }
        if self.shared.cancel.load(Ordering::Relaxed) {
            self.shared.cancelled.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        self.local.push(found);
        WalkState::Continue
    }
}

impl CollectVisitor<'_> {
    /// Whether a symlink points at a file inside the root. Folders are never followed.
    fn links_to_file(&self, entry: &DirEntry) -> bool {
        std::fs::canonicalize(entry.path())
            .is_ok_and(|target| target.starts_with(self.shared.root.path()) && target.is_file())
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
