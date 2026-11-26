// SPDX-License-Identifier: Apache-2.0
//! `workspaceRevision` (`index.ts:644`): the head and the snapshot's tree, under the checkout's
//! lease, with the person's index and checkout untouched.

use super::workspace_revision;
use crate::checkpoints::restore::{Guard, Lock};
use crate::checkpoints::snapshot::{DirectCapture, SnapshotContext, snapshot};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitError;
use crate::core::spawn::BoxFuture;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

#[derive(Default)]
struct CountingLock {
    taken: std::sync::Mutex<u32>,
}

impl Lock for CountingLock {
    fn acquire<'a>(&'a self, _root: &'a str) -> BoxFuture<'a, Result<Guard, GitError>> {
        Box::pin(async move {
            let mut taken = self.taken.lock().expect("lock");
            *taken += 1;
            Ok(Guard(u64::from(*taken)))
        })
    }

    fn release(&self, _guard: Guard) {}
}

struct Harness {
    fixture: Fixture,
    root: String,
    temp: String,
}

impl Harness {
    fn new(name: &str) -> Self {
        let fixture = Fixture::new(name);
        let repo = fixture.repository("repo");
        let root = std::fs::canonicalize(&repo)
            .expect("root")
            .to_string_lossy()
            .into_owned();
        let temp = fixture.root.join("tmp");
        std::fs::create_dir_all(&temp).expect("temp");
        Self {
            fixture,
            root,
            temp: temp.to_string_lossy().into_owned(),
        }
    }

    fn context(&self) -> SnapshotContext {
        SnapshotContext {
            temp_directory: self.temp.clone(),
            platform: String::from("darwin"),
            now: Box::new(|| String::from("2026-11-26T09:00:00.000Z")),
        }
    }

    fn port(&self) -> ProcessCommands<'_> {
        ProcessCommands {
            fixture: &self.fixture,
        }
    }

    fn text(&self, args: &[&str]) -> String {
        String::from_utf8_lossy(&self.fixture.git(std::path::Path::new(&self.root), args))
            .trim_end()
            .to_owned()
    }
}

#[tokio::test]
async fn a_clean_checkout_reports_its_head_and_tree() {
    let harness = Harness::new("workspace-clean");
    let context = harness.context();
    let port = harness.port();
    let lock = CountingLock::default();
    assert_eq!(
        workspace_revision(&port, &context, &lock, &harness.root)
            .await
            .expect("revision"),
        format!(
            "{}:{}",
            harness.text(&["rev-parse", "HEAD"]),
            harness.text(&["rev-parse", "HEAD^{tree}"])
        )
    );
    assert_eq!(*lock.taken.lock().expect("taken"), 1, "the lease is taken");
}

#[tokio::test]
async fn an_uncommitted_edit_changes_the_tree_and_not_the_head() {
    let harness = Harness::new("workspace-dirty");
    let context = harness.context();
    let port = harness.port();
    let lock = CountingLock::default();
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "edited\n",
    )
    .expect("edit");
    std::fs::write(std::path::Path::new(&harness.root).join("new.txt"), "new\n").expect("new");
    let revision = workspace_revision(&port, &context, &lock, &harness.root)
        .await
        .expect("revision");
    let capture = DirectCapture {
        port: &port,
        context: &context,
    };
    let tree = snapshot(&port, &context, &harness.root, None, &capture)
        .await
        .expect("snapshot");
    assert_eq!(
        revision,
        format!("{}:{tree}", harness.text(&["rev-parse", "HEAD"]))
    );
    assert_ne!(tree, harness.text(&["rev-parse", "HEAD^{tree}"]));
    // The person's index was never written: the snapshot used a temporary one.
    assert_eq!(
        harness.text(&["diff", "--cached", "--name-only"]),
        "",
        "nothing is staged"
    );
}

#[tokio::test]
async fn an_unborn_branch_reports_unborn() {
    let harness = Harness::new("workspace-unborn");
    let repo = std::path::Path::new(&harness.root).join("fresh");
    std::fs::create_dir_all(&repo).expect("fresh");
    harness.fixture.git(&repo, &["init", "--quiet"]);
    std::fs::write(repo.join("first.txt"), "first\n").expect("file");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let context = harness.context();
    let port = harness.port();
    let lock = CountingLock::default();
    let revision = workspace_revision(&port, &context, &lock, &root)
        .await
        .expect("revision");
    let tree = revision
        .strip_prefix("unborn:")
        .expect("unborn, then the tree");
    assert_eq!(tree.len(), 40);
    // The unborn checkout's tree holds the file.
    let listing = port
        .run(Command::new(&root, &["ls-tree", "-r", "--name-only", tree]))
        .await
        .expect("ls-tree");
    assert_eq!(
        String::from_utf8_lossy(&listing.stdout).trim_end(),
        "first.txt"
    );
}
