// SPDX-License-Identifier: Apache-2.0

//! `watch`: change batches for one checkout.
//!
//! One watcher per root serves every subscription. Each batch first makes the cached folder
//! listings stale and folds the changes into the quick-open index, then reaches every subscriber
//! as an `event`, so a client that just asked for a folder sees what the batch changed.
//!
//! This module's sink runs on the watcher's own thread, never on a runtime worker: it writes
//! through [`Out::send_blocking`], so a daemon that stops reading slows the watcher instead of
//! growing a queue.

use std::sync::Arc;

use files_index::IndexChange;
use files_watch::{Batch, Change, ChangeKind};
use files_wire::{EventPayload, Message, Reply};

use crate::convert;
use crate::dispatch::{Shared, joined};
use crate::error::Error;
use crate::requests::Cancel;
use crate::roots::RootEntry;
use crate::subscriptions::{Kind, Subscriptions};
use crate::writer::Out;

/// Start a watch: bring the root's watcher up, then hand out the subscription that receives its
/// batches.
pub async fn start(shared: &Shared, id: u64, cancel: Cancel, root: u64) {
    let entry = match shared.roots.get(root) {
        Ok(entry) => entry,
        Err(error) => return shared.respond(id, Err(error)).await,
    };
    let starting = {
        let entry = Arc::clone(&entry);
        let subscriptions = Arc::clone(&shared.subscriptions);
        let out = shared.out.clone();
        tokio::task::spawn_blocking(move || entry.ensure_watcher(&subscriptions, &out))
    };
    let result = match joined(starting.await) {
        Ok(()) if cancel.cancelled() => Err(Error::Aborted),
        Ok(()) => entry
            .subscribe(&shared.subscriptions, Kind::Watch, None)
            .map(|subscription| Reply::Subscription { subscription }),
        Err(error) => Err(error),
    };
    shared.respond(id, result).await;
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
                Some(dir) => {
                    entry.lister().invalidate(&[dir]);
                    entry.apply_changes(&subtree(dir));
                }
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
                out.send_blocking(Message::Event {
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

/// A folder the watcher could not describe change by change: forget everything indexed under it,
/// then walk it again, so quick open sees exactly what survived.
fn subtree(dir: &str) -> Vec<IndexChange> {
    vec![
        IndexChange {
            path: dir.to_owned(),
            deleted: true,
            directory: true,
        },
        IndexChange {
            path: dir.to_owned(),
            deleted: false,
            directory: true,
        },
    ]
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

#[cfg(test)]
mod tests {
    // Test-only code: a fixture that cannot be built is a failed assertion.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use tokio::runtime::Handle;

    use super::*;
    use crate::roots::Roots;
    use crate::writer::Out;

    fn file(dir: &Path, path: &str) {
        let full = dir.join(path);
        fs::create_dir_all(full.parent().expect("a parent")).expect("the folder");
        fs::write(full, "x").expect("the file");
    }

    /// Wait until the background build has published its index.
    async fn indexed(entry: &Arc<RootEntry>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if entry.index_query("a", 10).is_ok_and(|index| index.ready) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the index never became ready");
    }

    fn paths(entry: &Arc<RootEntry>, query: &str) -> Vec<String> {
        match entry.index_query(query, 20) {
            Ok(index) => index.hits.into_iter().map(|hit| hit.path).collect(),
            Err(error) => panic!("indexQuery failed: {error}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_rescan_of_one_folder_replaces_that_folder_and_nothing_else() {
        let checkout = tempfile::tempdir().expect("a temp dir");
        file(checkout.path(), "keep/still.txt");
        file(checkout.path(), "gone/old.txt");
        let roots = Roots::new(Handle::current());
        let entry = roots.open(checkout.path()).expect("the root opens");
        entry.start_index();
        indexed(&entry).await;
        assert_eq!(paths(&entry, "old"), ["gone/old.txt"]);

        // The watcher lost track of the folder: one path vanished, another appeared, and neither
        // was reported change by change.
        fs::remove_file(checkout.path().join("gone/old.txt")).expect("the delete");
        file(checkout.path(), "gone/new.txt");

        let out = Out::discard();
        deliver(
            &entry,
            &Arc::new(Subscriptions::default()),
            &out,
            Batch::Rescan {
                dir: Some("gone".to_owned()),
            },
        );

        assert_eq!(
            paths(&entry, "old"),
            Vec::<String>::new(),
            "the rescan drops the paths that vanished"
        );
        assert_eq!(paths(&entry, "new"), ["gone/new.txt"]);
        assert_eq!(
            paths(&entry, "still"),
            ["keep/still.txt"],
            "a folder the rescan did not name keeps its paths"
        );
    }
}
