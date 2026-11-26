// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! The real edge A3 needs: `files-watch` reports a write and `files-list`/`files-io` seed and
//! reconcile it, through the same adapter the daemon uses.

use std::sync::mpsc;
use std::time::Duration;

use ace_automations::scheduler::CounterIds;
use ace_automations::workspace::{
    Checkout, FileEvent, FilesCheckout, FilesWatch, WorkspaceHooks, WorkspaceLimits, WorkspaceOpen,
    subscribe,
};

#[test]
fn a_created_file_is_reported_through_the_files_backends_own_watcher() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    std::fs::create_dir_all(root.join("src")).expect("src");
    std::fs::write(root.join("src/a.ts"), b"a").expect("seed file");

    let checkout = FilesCheckout::open(root).expect("checkout");
    assert!(
        checkout
            .walk()
            .expect("walk")
            .iter()
            .any(|entry| entry.path == "src/a.ts")
    );

    let (ready_tx, ready_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let mut subscription = subscribe(WorkspaceOpen {
        checkout: Box::new(checkout),
        watch: &FilesWatch::new(),
        root: root.to_str().expect("utf8"),
        patterns: &["src/**".to_owned()],
        limits: WorkspaceLimits::default(),
        ids: Box::new(CounterIds::new("trigger")),
        receive: Box::new(move |event: FileEvent| {
            let _ = event_tx.send(event);
        }),
        hooks: WorkspaceHooks {
            on_ready: Some(Box::new(move || {
                let _ = ready_tx.send(());
            })),
            on_error: None,
        },
    })
    .expect("subscribe");
    ready_rx
        .recv_timeout(Duration::from_secs(4))
        .expect("ready");

    std::fs::write(root.join("src/b.ts"), b"b").expect("write");
    let event = event_rx
        .recv_timeout(Duration::from_secs(4))
        .expect("file event");
    assert_eq!(
        event.variables.get("path").map(String::as_str),
        Some("src/b.ts")
    );
    assert_eq!(
        event.variables.get("kind").map(String::as_str),
        Some("created")
    );
    subscription.stop();
}
