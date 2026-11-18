// SPDX-License-Identifier: Apache-2.0

//! `search`: content search that streams one event per file and finishes with a summary.

use std::sync::atomic::Ordering;

use files_search::Summary;
use files_wire::{EventPayload, Message, Reply, SearchQuery};

use crate::convert;
use crate::dispatch::Shared;
use crate::error::Error;
use crate::requests::Cancel;
use crate::roots::RootEntry;
use crate::subscriptions::Kind;

/// Start a search: answer with the subscription at once, then stream matches from a blocking
/// thread that walks the checkout on every core.
pub fn start(shared: &Shared, id: u64, cancel: Cancel, root: u64, query: SearchQuery) {
    let entry = match shared.roots.get(root) {
        Ok(entry) => entry,
        Err(error) => return shared.respond(id, Err(error)),
    };
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
    tokio::task::spawn_blocking(move || {
        let outcome = run(&entry, &query, &cancel, &job, subscription);
        job.finish_search(id, subscription, outcome);
    });
}

/// Walk the checkout, sending one `matches` event per file. A cancelled request stops the walk at
/// the next file or read.
fn run(
    entry: &RootEntry,
    query: &SearchQuery,
    cancel: &Cancel,
    shared: &Shared,
    subscription: u64,
) -> Result<Summary, Error> {
    let query = convert::search_query(query.clone());
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
    Ok(files_search::search(entry.root(), &query, &flag, &sink)?)
}
