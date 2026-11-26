// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports the eight cases of `apps/daemon/src/automation-workspace.test.ts` over the
//! reconciler ports: matching patterns, gitignore flags, the seed buffer, rescan and live-batch
//! deduplication, content digests and the snapshot bound.

use std::collections::HashMap;
use std::sync::Mutex;

use ace_automations::scheduler::CounterIds;
use ace_automations::workspace::{
    Checkout, CheckoutEntry, FileEvent, Reconciler, WatchChange, WatchKind, WorkspaceLimits,
    WorkspacePayload,
};

#[derive(Clone)]
struct Version {
    size: u64,
    mtime: i64,
}

struct FakeCheckout {
    versions: Mutex<Vec<(String, Version)>>,
    digests: Mutex<HashMap<String, String>>,
    ignored: Vec<String>,
}

impl FakeCheckout {
    fn new(entries: &[(&str, u64, i64)], ignored: &[&str]) -> FakeCheckout {
        FakeCheckout {
            versions: Mutex::new(
                entries
                    .iter()
                    .map(|(path, size, mtime)| {
                        (
                            (*path).to_owned(),
                            Version {
                                size: *size,
                                mtime: *mtime,
                            },
                        )
                    })
                    .collect(),
            ),
            digests: Mutex::new(
                entries
                    .iter()
                    .map(|(path, _, _)| ((*path).to_owned(), (*path).to_owned()))
                    .collect(),
            ),
            ignored: ignored.iter().map(|path| (*path).to_owned()).collect(),
        }
    }

    fn set(&self, path: &str, size: u64, mtime: i64) {
        let mut versions = self.versions.lock().expect("versions");
        if let Some(entry) = versions.iter_mut().find(|(known, _)| known == path) {
            entry.1 = Version { size, mtime };
        } else {
            versions.push((path.to_owned(), Version { size, mtime }));
        }
    }

    fn remove(&self, path: &str) {
        self.versions
            .lock()
            .expect("lock")
            .retain(|(known, _)| known != path);
        self.digests.lock().expect("digests").remove(path);
    }

    fn set_digest(&self, path: &str, digest: &str) {
        self.digests
            .lock()
            .expect("lock")
            .insert(path.to_owned(), digest.to_owned());
    }

    fn entry(&self, path: &str) -> Option<CheckoutEntry> {
        let versions = self.versions.lock().expect("versions");
        let (_, version) = versions.iter().find(|(known, _)| known == path)?;
        Some(CheckoutEntry {
            path: path.to_owned(),
            version: format!("file:{}:{}", version.size, version.mtime),
            file: true,
            directory: false,
            ignored: self.ignored.iter().any(|ignored| ignored == path),
        })
    }
}

impl Checkout for FakeCheckout {
    fn walk(&self) -> ace_automations::Result<Vec<CheckoutEntry>> {
        let versions = self.versions.lock().expect("lock").clone();
        Ok(versions
            .iter()
            .map(|(path, version)| CheckoutEntry {
                path: path.clone(),
                version: format!("file:{}:{}", version.size, version.mtime),
                file: true,
                directory: false,
                ignored: self.ignored.iter().any(|ignored| ignored == path),
            })
            .collect())
    }

    fn stat(&self, path: &str) -> ace_automations::Result<Option<CheckoutEntry>> {
        Ok(self.entry(path))
    }

    fn digest(&self, path: &str) -> ace_automations::Result<Option<String>> {
        Ok(self.digests.lock().expect("digests").get(path).cloned())
    }
}

fn changed(path: &str) -> WatchChange {
    WatchChange {
        path: path.to_owned(),
        kind: WatchKind::Modified,
        directory: false,
    }
}

fn created(path: &str) -> WatchChange {
    WatchChange {
        path: path.to_owned(),
        kind: WatchKind::Created,
        directory: false,
    }
}

fn kinds(events: &[FileEvent]) -> Vec<(String, String, String)> {
    events
        .iter()
        .map(|event| {
            (
                event.variables.get("path").cloned().unwrap_or_default(),
                event.variables.get("kind").cloned().unwrap_or_default(),
                event.variables.get("count").cloned().unwrap_or_default(),
            )
        })
        .collect()
}

#[test]
fn a_file_trigger_fires_for_matching_non_ignored_changes_and_reconciles_a_rescan() {
    let fake = std::sync::Arc::new(FakeCheckout::new(
        &[("src/a.ts", 1, 1)],
        &["build/out.js", "src/error.log"],
    ));
    let mut reconciler = reconciler_shared(fake.clone(), &["src/**"], WorkspaceLimits::default());
    reconciler.seed().expect("seed");
    fake.set("src/a.ts", 2, 2);
    fake.set_digest("src/a.ts", "a2");
    let events = reconciler
        .receive(
            WorkspacePayload::Changes(vec![
                changed("src/a.ts"),
                created("build/out.js"),
                created("docs/b.ts"),
                created("src/error.log"),
            ]),
            false,
        )
        .expect("batch");
    assert_eq!(
        kinds(&events),
        vec![("src/a.ts".to_owned(), "changed".to_owned(), "1".to_owned())]
    );
    fake.set("src/b.ts", 1, 1);
    let events = reconciler
        .receive(WorkspacePayload::Rescan, false)
        .expect("rescan");
    assert_eq!(
        kinds(&events),
        vec![("src/b.ts".to_owned(), "created".to_owned(), "1".to_owned())]
    );
}

#[test]
fn an_event_that_lands_while_the_baseline_is_read_is_delivered_once_after_ready() {
    let fake = std::sync::Arc::new(FakeCheckout::new(
        &[("src/main.ts", 1, 1), ("src/late.ts", 2, 2)],
        &[],
    ));
    let mut reconciler = reconciler_shared(fake, &["src/**"], WorkspaceLimits::default());
    reconciler.begin_buffering();
    reconciler
        .receive(
            WorkspacePayload::Changes(vec![created("src/late.ts")]),
            false,
        )
        .expect("held");
    reconciler.seed().expect("seed");
    let events = reconciler.ready().expect("ready");
    assert_eq!(
        kinds(&events),
        vec![(
            "src/late.ts".to_owned(),
            "created".to_owned(),
            "1".to_owned()
        )]
    );
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("rescan")
            .is_empty()
    );
}

#[test]
fn a_rescan_detects_a_same_size_edit_whose_modification_time_was_put_back() {
    let fake = std::sync::Arc::new(FakeCheckout::new(&[("src/a.ts", 4, 10)], &[]));
    let mut reconciler = reconciler_shared(fake.clone(), &["src/**"], WorkspaceLimits::default());
    reconciler.seed().expect("seed");
    fake.set_digest("src/a.ts", "bbbb");
    let events = reconciler
        .receive(WorkspacePayload::Rescan, false)
        .expect("rescan");
    assert_eq!(
        kinds(&events),
        vec![("src/a.ts".to_owned(), "changed".to_owned(), "1".to_owned())]
    );
}

#[test]
fn a_live_modification_is_reported_even_when_its_version_equals_the_baseline() {
    let fake = std::sync::Arc::new(FakeCheckout::new(&[("src/a.ts", 4, 10)], &[]));
    let mut reconciler = reconciler_shared(fake.clone(), &["src/**"], WorkspaceLimits::default());
    reconciler.seed().expect("seed");
    fake.set_digest("src/a.ts", "bbbb");
    let events = reconciler
        .receive(WorkspacePayload::Changes(vec![changed("src/a.ts")]), false)
        .expect("batch");
    assert_eq!(
        kinds(&events),
        vec![("src/a.ts".to_owned(), "changed".to_owned(), "1".to_owned())]
    );
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("rescan")
            .is_empty()
    );
}

#[test]
fn a_rescan_and_the_live_batch_that_follows_report_one_change() {
    let fake = std::sync::Arc::new(FakeCheckout::new(&[("src/a.ts", 4, 10)], &[]));
    let mut reconciler = reconciler_shared(fake.clone(), &["src/**"], WorkspaceLimits::default());
    reconciler.seed().expect("seed");
    fake.set("src/a.ts", 5, 11);
    fake.set_digest("src/a.ts", "bbbbb");
    let events = reconciler
        .receive(WorkspacePayload::Rescan, false)
        .expect("rescan");
    assert_eq!(events.len(), 1);
    assert!(
        reconciler
            .receive(WorkspacePayload::Changes(vec![changed("src/a.ts")]), false)
            .expect("late batch")
            .is_empty()
    );
}

#[test]
fn an_incomplete_scan_keeps_the_last_complete_baseline_instead_of_inventing_creates() {
    let fake = std::sync::Arc::new(FakeCheckout::new(
        &[("src/a.ts", 1, 1), ("src/b.ts", 1, 1), ("src/c.ts", 1, 1)],
        &[],
    ));
    let mut reconciler = reconciler_shared(
        fake.clone(),
        &["src/**"],
        WorkspaceLimits {
            snapshot_limit: 2,
            buffer_limit: 100,
        },
    );
    // The seed can't read everything: no baseline yet.
    reconciler.seed().expect("seed");
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("full rescan")
            .is_empty()
    );
    fake.remove("src/c.ts");
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("seeding rescan")
            .is_empty()
    );
    // That scan was a valid baseline; content that moved is a change.
    fake.set_digest("src/a.ts", "A");
    let events = reconciler
        .receive(WorkspacePayload::Rescan, false)
        .expect("content change");
    assert_eq!(
        kinds(&events),
        vec![("src/a.ts".to_owned(), "changed".to_owned(), "1".to_owned())]
    );
    // A later scan that can't see everything leaves the complete baseline in place.
    fake.set("src/d.ts", 1, 1);
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("too big")
            .is_empty()
    );
    fake.remove("src/d.ts");
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("restored")
            .is_empty()
    );
}

#[test]
fn a_live_save_that_reuses_the_version_a_rescan_reported_is_still_a_change() {
    let fake = std::sync::Arc::new(FakeCheckout::new(&[("src/a.ts", 4, 10)], &[]));
    let mut reconciler = reconciler_shared(fake.clone(), &["src/**"], WorkspaceLimits::default());
    reconciler.seed().expect("seed");
    fake.set("src/a.ts", 5, 11);
    fake.set_digest("src/a.ts", "bbbbb");
    assert_eq!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("rescan")
            .len(),
        1
    );
    // Another save keeps the version the rescan reported but changes the bytes again.
    fake.set_digest("src/a.ts", "ccccc");
    let events = reconciler
        .receive(WorkspacePayload::Changes(vec![changed("src/a.ts")]), false)
        .expect("late save");
    assert_eq!(
        kinds(&events),
        vec![("src/a.ts".to_owned(), "changed".to_owned(), "1".to_owned())]
    );
}

#[test]
fn a_rescan_of_an_untouched_checkout_reports_nothing() {
    let fake = std::sync::Arc::new(FakeCheckout::new(&[("src/keep.ts", 4, 7)], &[]));
    let mut reconciler = reconciler_shared(fake, &["src/**"], WorkspaceLimits::default());
    reconciler.seed().expect("seed");
    assert!(
        reconciler
            .receive(WorkspacePayload::Rescan, false)
            .expect("rescan")
            .is_empty()
    );
}

/// A handle to the fake after the reconciler owns its boxed copy.
struct SharedCheckout(std::sync::Arc<FakeCheckout>);

impl Checkout for SharedCheckout {
    fn walk(&self) -> ace_automations::Result<Vec<CheckoutEntry>> {
        self.0.walk()
    }
    fn stat(&self, path: &str) -> ace_automations::Result<Option<CheckoutEntry>> {
        self.0.stat(path)
    }
    fn digest(&self, path: &str) -> ace_automations::Result<Option<String>> {
        self.0.digest(path)
    }
}

fn reconciler_shared(
    fake: std::sync::Arc<FakeCheckout>,
    patterns: &[&str],
    limits: WorkspaceLimits,
) -> Reconciler {
    Reconciler::new(
        Box::new(SharedCheckout(fake)),
        &patterns
            .iter()
            .map(|pattern| (*pattern).to_owned())
            .collect::<Vec<_>>(),
        limits,
        Box::new(CounterIds::new("trigger")),
    )
    .expect("reconciler")
}
