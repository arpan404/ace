// SPDX-License-Identifier: Apache-2.0

//! Drives the parallel walk and turns each searched file into a sink call.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use files_safe::Root;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use ignore::WalkBuilder;
use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkState};

use crate::error::Error;
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
    pub(crate) max_file_bytes: u64,
    pub(crate) limit: u64,
    pub(crate) matches: AtomicU64,
    pub(crate) files: AtomicU64,
    pub(crate) bytes: AtomicU64,
    pub(crate) stop: AtomicBool,
    pub(crate) limit_hit: AtomicBool,
}

impl Shared<'_> {
    /// Whether every walker thread should stop now.
    pub(crate) fn halted(&self) -> bool {
        self.stop.load(Ordering::SeqCst) || self.cancel.load(Ordering::SeqCst)
    }

    /// Claims one slot under the match cap. False means the cap is used up.
    pub(crate) fn reserve(&self) -> bool {
        let mut seen = self.matches.load(Ordering::Relaxed);
        loop {
            if seen >= self.limit {
                self.limit_hit.store(true, Ordering::SeqCst);
                self.stop.store(true, Ordering::SeqCst);
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
        max_file_bytes: plan.max_file_bytes,
        limit: plan.limit,
        matches: AtomicU64::new(0),
        files: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        stop: AtomicBool::new(false),
        limit_hit: AtomicBool::new(false),
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
        .ignore(!query.include_ignored);
    builder
        .build_parallel()
        .visit(&mut Workers { shared: &shared });
    if cancel.load(Ordering::SeqCst) {
        return Err(Error::Aborted);
    }
    Ok(Summary {
        files: shared.files.load(Ordering::SeqCst),
        bytes: shared.bytes.load(Ordering::SeqCst),
        matches: shared.matches.load(Ordering::SeqCst),
        limit_hit: shared.limit_hit.load(Ordering::SeqCst),
    })
}

/// Hands each walker thread a search visitor with its own reusable searcher.
struct Workers<'a, 'shared> {
    shared: &'shared Shared<'a>,
}

impl<'s, 'a: 's, 'shared: 's> ParallelVisitorBuilder<'s> for Workers<'a, 'shared> {
    fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
        Box::new(Worker {
            shared: self.shared,
            searcher: searcher(),
        })
    }
}

/// One walker thread: searches the files its walk hands to it.
struct Worker<'a> {
    shared: &'a Shared<'a>,
    searcher: Searcher,
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
            search_file(&mut self.searcher, self.shared, entry.path());
        }
        if self.shared.halted() {
            WalkState::Quit
        } else {
            WalkState::Continue
        }
    }
}

/// Line numbers on, binary files stopped at the first NUL, one line per match.
fn searcher() -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(0))
        .build()
}
