// SPDX-License-Identifier: Apache-2.0

//! `watch`: change batches for one checkout.
//!
//! One watcher per root serves every subscription. Each batch first makes the cached folder
//! listings stale and folds the changes into the quick-open index, then reaches every subscriber
//! as an `event`, so a client that just asked for a folder sees what the batch changed.

use std::sync::Arc;

use files_index::IndexChange;
use files_watch::{Batch, Change, ChangeKind};
use files_wire::{EventPayload, Message, Reply};

use crate::convert;
use crate::dispatch::{Shared, joined};
use crate::error::Error;
use crate::io::Out;
use crate::requests::Cancel;
use crate::roots::RootEntry;
use crate::subscriptions::{Kind, Subscriptions};

/// Start a watch: bring the root's watcher up, then hand out the subscription that receives its
/// batches.
pub fn start(shared: &Shared, id: u64, cancel: Cancel, root: u64) {
    let entry = match shared.roots.get(root) {
        Ok(entry) => entry,
        Err(error) => return shared.respond(id, Err(error)),
    };
    let job = shared.clone();
    tokio::spawn(async move {
        let starting = {
            let entry = Arc::clone(&entry);
            let subscriptions = Arc::clone(&job.subscriptions);
            let out = job.out.clone();
            tokio::task::spawn_blocking(move || entry.ensure_watcher(&subscriptions, &out))
        };
        let result = match joined(starting.await) {
            Ok(()) if cancel.cancelled() => Err(Error::Aborted),
            Ok(()) => entry
                .subscribe(&job.subscriptions, Kind::Watch, None)
                .map(|subscription| Reply::Subscription { subscription }),
            Err(error) => Err(error),
        };
        job.respond(id, result);
    });
}

/// Apply one batch, then forward it to every watch subscription on the root.
pub fn deliver(
    entry: &Arc<RootEntry>,
    subscriptions: &Arc<Subscriptions>,
    out: &Out,
    batch: Batch,
) {
    let payload = match batch {
        Batch::Changes(changes) => {
            invalidate(entry, &changes);
            entry.apply_changes(&index_changes(&changes));
            EventPayload::Changes {
                changes: changes.into_iter().map(convert::change).collect(),
            }
        }
        Batch::Rescan { dir } => {
            match dir.as_deref() {
                Some(dir) => entry.lister().invalidate(&[dir]),
                None => {
                    entry.lister().invalidate(&[""]);
                    entry.rescan_index();
                }
            }
            EventPayload::Rescan { dir }
        }
        Batch::Warning(message) => {
            eprintln!("ace-files: watcher: {message}");
            EventPayload::Warning { message }
        }
    };
    match subscriptions.watches(entry.id()) {
        Ok(watches) => {
            for subscription in watches {
                out.send(Message::Event {
                    subscription,
                    payload: payload.clone(),
                });
            }
        }
        Err(error) => eprintln!(
            "ace-files: cannot list the watches of root {}: {error}",
            entry.id()
        ),
    }
}

/// Drop the cached listings a batch makes stale: the folder each path sits in, and the path
/// itself when it is a folder, since its own listing changed too.
fn invalidate(entry: &RootEntry, changes: &[Change]) {
    let mut folders: Vec<&str> = Vec::with_capacity(changes.len() * 2);
    for change in changes {
        if change.directory {
            folders.push(change.path.as_str());
        }
        folders.push(match change.path.rsplit_once('/') {
            Some((parent, _)) => parent,
            None => "",
        });
    }
    folders.sort_unstable();
    folders.dedup();
    entry.lister().invalidate(&folders);
}

/// The batch in the index's terms: a delete removes a subtree, anything else adds or refreshes a
/// path and walks the subtree of a new folder.
fn index_changes(changes: &[Change]) -> Vec<IndexChange> {
    changes
        .iter()
        .map(|change| IndexChange {
            path: change.path.clone(),
            deleted: change.kind == ChangeKind::Deleted,
            directory: change.directory,
        })
        .collect()
}
