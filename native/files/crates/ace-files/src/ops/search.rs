// SPDX-License-Identifier: Apache-2.0

//! `search`: content search that streams one event per file and finishes with a summary.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use files_search::Summary;
use files_wire::{EventPayload, Message, Reply, SearchQuery};

use crate::convert;
use crate::dispatch::{Shared, joined};
use crate::error::Error;
use crate::requests::Cancel;
use crate::roots::RootEntry;
use crate::subscriptions::Kind;

/// Start a search: answer with the subscription at once, then stream matches from a blocking
/// thread that walks the checkout on every core.
///
/// The query is checked before the daemon is told a subscription exists, because a request is
/// answered exactly once: from then on a failure is a `searchFailed` event on the subscription.
pub fn start(shared: &Shared, id: u64, cancel: Cancel, root: u64, query: SearchQuery) {
    let entry = match shared.roots.get(root) {
        Ok(entry) => entry,
        Err(error) => return shared.respond(id, Err(error)),
    };
    let query = convert::search_query(query);
    if let Err(error) = validate(&query) {
        return shared.respond(id, Err(error));
    }
    let subscription =
        match entry.subscribe(&shared.subscriptions, Kind::Search, Some(cancel.flag())) {
            Ok(subscription) => subscription,
            Err(error) => return shared.respond(id, Err(error)),
        };
    shared.out.send(Message::Response {
        id,
        result: Reply::Subscription { subscription },
    });
    let job = shared.clone();
    tokio::spawn(async move {
        let running = {
            let entry = Arc::clone(&entry);
            let cancel = cancel.clone();
            let shared = job.clone();
            tokio::task::spawn_blocking(move || run(&entry, &query, &cancel, &shared, subscription))
        };
        // A worker that panicked is a failure like any other: the subscription hears about it
        // instead of waiting for a summary that will never come.
        job.finish_search(id, subscription, joined(running.await));
    });
}

/// Test-only: a search for exactly this pattern panics on its worker thread, so a test can prove
/// that a stopped worker becomes `searchFailed` rather than a request that never finishes.
fn panics_on_purpose(query: &files_search::Query) -> bool {
    std::env::var("ACE_FILES_PANIC_SEARCH").is_ok_and(|pattern| pattern == query.pattern)
}

/// Refuse a pattern the searcher could not compile, before any subscription exists.
///
/// `files-search` owns what a query matches; this asks only whether the pattern parses as a
/// regular expression, which is the one refusal that crate reports before it walks anything. A
/// pattern that parses here and is refused there travels as a `searchFailed` event instead, so
/// either way the request itself has a single answer.
fn validate(query: &files_search::Query) -> Result<(), Error> {
    if query.pattern.is_empty() {
        return Err(Error::InvalidArgument("pattern is empty".to_owned()));
    }
    if !query.regex {
        return Ok(());
    }
    regex::Regex::new(&query.pattern)
        .map(|_| ())
        .map_err(|error| Error::InvalidArgument(error.to_string()))
}

/// Walk the checkout, sending one `matches` event per file. A cancelled request stops the walk at
/// the next file or read.
fn run(
    entry: &RootEntry,
    query: &files_search::Query,
    cancel: &Cancel,
    shared: &Shared,
    subscription: u64,
) -> Result<Summary, Error> {
    if panics_on_purpose(query) {
        panic!("test hook: the search worker panics");
    }
    let flag = cancel.flag();
    let stopped = cancel.flag();
    let out = shared.out.clone();
    let sink = move |file: files_search::FileMatches| {
        if stopped.load(Ordering::Relaxed) {
            return false;
        }
        out.send(Message::Event {
            subscription,
            payload: EventPayload::Matches {
                file: convert::file_matches(file),
            },
        });
        true
    };
    Ok(files_search::search(entry.root(), query, &flag, &sink)?)
}
