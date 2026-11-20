// SPDX-License-Identifier: Apache-2.0

//! Drives the parallel walk and turns each searched file into a sink call.

use std::ffi::OsStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use files_safe::Root;
use globset::GlobSet;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use ignore::WalkBuilder;
use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkState};

use crate::error::Error;
use crate::folders::Folders;
#[cfg(target_os = "macos")]
use crate::pace::{Pace, Paced};
use crate::parents::Inherited;
use crate::pattern::{self, Plan};
use crate::query::Query;
use crate::result::{FileMatches, Summary};
use crate::sink::search_file;

/// Counters and limits every walker thread shares.
pub(crate) struct Shared<'a> {
    pub(crate) root: &'a Root,
    pub(crate) sink: &'a (dyn Fn(FileMatches) -> bool + Sync),
    pub(crate) cancel: &'a AtomicBool,
    pub(crate) matcher: RegexMatcher,
    pub(crate) includes: Option<GlobSet>,
    pub(crate) max_file_bytes: u64,
    pub(crate) limit: u64,
    pub(crate) matches: AtomicU64,
    pub(crate) refused: AtomicU64,
    pub(crate) files: AtomicU64,
    pub(crate) bytes: AtomicU64,
    pub(crate) sink_stopped: AtomicBool,
    pub(crate) limit_stopped: AtomicBool,
    /// True once the sink has returned `false`; held by whoever is calling the sink.
    pub(crate) gate: Mutex<bool>,
}

impl Shared<'_> {
    /// Whether every walker thread should stop now.
    pub(crate) fn halted(&self) -> bool {
        self.sink_stopped.load(Ordering::SeqCst)
            || self.limit_stopped.load(Ordering::SeqCst)
            || self.cancel.load(Ordering::SeqCst)
    }

    /// Claims one slot under the match cap. False means the cap is used up.
    pub(crate) fn reserve(&self) -> bool {
        let mut seen = self.matches.load(Ordering::Relaxed);
        loop {
            if seen >= self.limit {
                self.limit_stopped.store(true, Ordering::SeqCst);
                return false;
            }
            match self.matches.compare_exchange_weak(
                seen,
                seen + 1,
                Ordering::SeqCst,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => seen = actual,
            }
        }
    }

    /// Gives back slots claimed by a file that was dropped before its matches were reported.
    pub(crate) fn release(&self, count: u64) {
        if count == 0 {
            return;
        }
        self.matches.fetch_sub(count, Ordering::SeqCst);
        if self.matches.load(Ordering::SeqCst) < self.limit {
            self.limit_stopped.store(false, Ordering::SeqCst);
        }
    }

    /// Whether an include glob admits this relative path.
    pub(crate) fn accepts(&self, relative: &str) -> bool {
        match &self.includes {
            Some(includes) => includes.is_match(relative),
            None => true,
        }
    }
}

/// Walks `root` in parallel and returns what the search found.
pub(crate) fn run(
    root: &Root,
    query: &Query,
    cancel: &AtomicBool,
    sink: &(dyn Fn(FileMatches) -> bool + Sync),
) -> Result<Summary, Error> {
    if cancel.load(Ordering::SeqCst) {
        return Err(Error::Aborted);
    }
    let plan = Plan::build(query)?;
    let overrides = pattern::overrides(root, query)?;
    let shared = Shared {
        root,
        sink,
        cancel,
        matcher: plan.matcher,
        includes: plan.includes,
        max_file_bytes: plan.max_file_bytes,
        limit: plan.limit,
        matches: AtomicU64::new(0),
        refused: AtomicU64::new(0),
        files: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        sink_stopped: AtomicBool::new(false),
        limit_stopped: AtomicBool::new(false),
        gate: Mutex::new(false),
    };
    let inherited = if query.include_ignored {
        None
    } else {
        Some(Inherited::find(root.path()))
    };
    let mut builder = WalkBuilder::new(root.path());
    builder
        .overrides(overrides)
        .hidden(false)
        .parents(false)
        .require_git(false)
        .git_global(false)
        .git_ignore(!query.include_ignored)
        .git_exclude(!query.include_ignored)
        .ignore(!query.include_ignored)
        .filter_entry(move |entry| keeps(entry, inherited.as_ref()));
    let threads = threads();
    builder.threads(threads);
    #[cfg(target_os = "macos")]
    let pace = Pace::new(threads);
    builder.build_parallel().visit(&mut Workers {
        shared: &shared,
        #[cfg(target_os = "macos")]
        pace: &pace,
    });
    if cancel.load(Ordering::SeqCst) {
        return Err(Error::Aborted);
    }
    Ok(Summary {
        files: shared.files.load(Ordering::SeqCst),
        bytes: shared.bytes.load(Ordering::SeqCst),
        matches: shared.matches.load(Ordering::SeqCst),
        limit_hit: shared.refused.load(Ordering::SeqCst) > 0,
    })
}

/// How many walker threads the walk starts.
///
/// macOS starts one per core, at most [`MAX_THREADS`], and [`crate::pace`] decides how many of
/// them run at once. Elsewhere the walker's own choice (one per core, at most 12) scales.
fn threads() -> usize {
    if cfg!(target_os = "macos") {
        std::thread::available_parallelism().map_or(1, |cores| cores.get().min(MAX_THREADS))
    } else {
        0
    }
}

/// The most walker threads a search starts on macOS. On a 16-core Mac, ten read a million-file tree
/// from the disk fastest; twelve were slower, and fourteen half as fast, as `open(2)` contends.
const MAX_THREADS: usize = 10;

/// Whether the walk may hand this entry on: never inside `.git`, and never when a folder above
/// the root ignores it.
fn keeps(entry: &DirEntry, inherited: Option<&Inherited>) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_name() == OsStr::new(".git") {
        return false;
    }
    match inherited {
        Some(inherited) => !inherited.ignores(
            entry.path(),
            entry.file_type().is_some_and(|kind| kind.is_dir()),
        ),
        None => true,
    }
}

/// Hands one finished file to the caller's sink, one call at a time.
///
/// True means the file was delivered, even if the sink then asked to stop. False means an earlier
/// call already returned `false`, so this file's slots must be given back instead.
pub(crate) fn emit(shared: &Shared<'_>, file: FileMatches) -> bool {
    let mut closed = match shared.gate.lock() {
        Ok(closed) => closed,
        Err(poisoned) => poisoned.into_inner(),
    };
    if *closed {
        shared.sink_stopped.store(true, Ordering::SeqCst);
        return false;
    }
    shared.files.fetch_add(1, Ordering::Relaxed);
    if !(shared.sink)(file) {
        *closed = true;
        shared.sink_stopped.store(true, Ordering::SeqCst);
    }
    true
}

/// Hands each walker thread a search visitor with its own reusable searcher.
struct Workers<'a, 'shared> {
    shared: &'shared Shared<'a>,
    #[cfg(target_os = "macos")]
    pace: &'shared Pace,
}

impl<'s, 'a: 's, 'shared: 's> ParallelVisitorBuilder<'s> for Workers<'a, 'shared> {
    fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
        Box::new(Worker {
            shared: self.shared,
            #[cfg(target_os = "macos")]
            paced: self.pace.join(),
            searcher: searcher(),
            folders: Folders::default(),
        })
    }
}

/// One walker thread: searches the files its walk hands to it.
struct Worker<'a> {
    shared: &'a Shared<'a>,
    /// Whether this thread may run now, on macOS.
    #[cfg(target_os = "macos")]
    paced: Paced<'a>,
    searcher: Searcher,
    /// The folders this thread already opened and proved, so a folder's files cost one open each.
    folders: Folders,
}

impl ParallelVisitor for Worker<'_> {
    fn visit(&mut self, entry: Result<DirEntry, ignore::Error>) -> WalkState {
        if self.shared.halted() {
            return WalkState::Quit;
        }
        let Ok(entry) = entry else {
            return WalkState::Continue;
        };
        if entry.file_type().is_some_and(|kind| kind.is_file()) {
            // Only a file waits its turn: a folder goes on at once, so the walk lists it and every
            // thread can take its entries, instead of one waiting thread holding a whole subtree.
            #[cfg(target_os = "macos")]
            {
                let shared = self.shared;
                self.paced.wait(|| shared.halted());
            }
            self.search(&entry);
        }
        if self.shared.halted() {
            WalkState::Quit
        } else {
            WalkState::Continue
        }
    }
}

impl Worker<'_> {
    /// Searches one file the walker yielded, if the include globs admit it.
    fn search(&mut self, entry: &DirEntry) {
        let Some(relative) = self.shared.root.relative(entry.path()) else {
            return;
        };
        if !self.shared.accepts(&relative) {
            return;
        }
        search_file(
            &mut self.searcher,
            self.shared,
            &mut self.folders,
            entry,
            &relative,
        );
    }
}

/// Line numbers on, binary files stopped at the first NUL, one line per match.
fn searcher() -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(0))
        .build()
}
