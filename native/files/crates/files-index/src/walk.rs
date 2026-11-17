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
#[derive(Debug, Clone, Default)]
pub(crate) struct Filters {
    pub hide: Vec<String>,
    pub include_ignored: bool,
}

impl Filters {
    /// Validate the hide patterns once, so a bad glob fails the build instead of silently hiding
    /// nothing.
    pub fn new(hide: &[String], include_ignored: bool) -> Result<Filters, Error> {
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
            hide: cleaned,
            include_ignored,
        })
    }
}

/// The files found by one walk.
pub(crate) struct Collected {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Walk `start` under `root` and collect every file, up to `max_files`.
///
/// Hidden files are included, because a person can open a dotfile; `.git` itself is always skipped,
/// because its object store is never a quick-open target and would fill any cap on its own.
pub(crate) fn collect(
    root: &Root,
    filters: &Filters,
    max_files: usize,
    cancel: &AtomicBool,
    start: &Path,
) -> Result<Collected, Error> {
    let mut builder = WalkBuilder::new(start);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .ignore(!filters.include_ignored)
        .git_ignore(!filters.include_ignored)
        .git_global(!filters.include_ignored)
        .git_exclude(!filters.include_ignored)
        .threads(rayon::current_num_threads().max(1))
        .overrides(overrides(root, filters)?);
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
fn overrides(root: &Root, filters: &Filters) -> Result<Override, Error> {
    let mut builder = OverrideBuilder::new(root.path());
    builder.add("!.git")?;
    for pattern in &filters.hide {
        builder.add(&format!("!{pattern}"))?;
    }
    Ok(builder.build()?)
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
