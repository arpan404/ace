// SPDX-License-Identifier: Apache-2.0
//! Checkpoint writes and reads (`checkpoints.ts`): the sequence, the counter's compare-and-swap,
//! reading one by id, listing a thread and deleting a thread. Real Git, fixtures only.

use super::{
    CreateCheckpoint, TokioWait, Wait, create_checkpoint, delete_checkpoints, list_checkpoints,
    read_checkpoint, ref_locked, retry_pause_ms,
};
use crate::checkpoints::metadata::{Checkpoint, checkpoint_prefix};
use crate::checkpoints::nested::{Capture, Ownership};
use crate::checkpoints::numbers::{CheckpointNumbers, Counter, counter_ref};
use crate::checkpoints::snapshot::{SnapshotContext, snapshot};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitErrorCode;
use crate::core::spawn::BoxFuture;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

const CREATED: &str = "2026-11-26T09:00:00.000Z";

struct NoWait;

impl Wait for NoWait {
    fn wait<'a>(&'a self, _milliseconds: u64) -> BoxFuture<'a, ()> {
        Box::pin(async move {})
    }
}

struct Direct<'a> {
    port: &'a dyn CommandPort,
    context: &'a SnapshotContext,
    ownership: Option<&'a Ownership>,
}

impl Capture for Direct<'_> {
    fn capture<'a>(&'a self, root: &'a str) -> BoxFuture<'a, Result<String, GitError>> {
        Box::pin(async move { snapshot(self.port, self.context, root, self.ownership, self).await })
    }
}

use crate::core::error::GitError;

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
            now: Box::new(|| CREATED.to_owned()),
        }
    }

    fn port(&self) -> ProcessCommands<'_> {
        ProcessCommands {
            fixture: &self.fixture,
        }
    }
}

#[tokio::test]
async fn creating_checkpoints_allocates_each_sequence_and_publishes_both_refs() {
    let harness = Harness::new("create-sequence");
    let context = harness.context();
    let port = harness.port();
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let mut numbers = CheckpointNumbers::default();
    let first = create_checkpoint(CreateCheckpoint {
        port: &port,
        context: &context,
        numbers: &mut numbers,
        wait: &TokioWait,
        root: &harness.root,
        thread_id: "thread-1",
        label: "before edit",
        ownership: None,
        capture: &capture,
    })
    .await
    .expect("first");
    let second = create_checkpoint(CreateCheckpoint {
        port: &port,
        context: &context,
        numbers: &mut numbers,
        wait: &TokioWait,
        root: &harness.root,
        thread_id: "thread-1",
        label: "after edit",
        ownership: None,
        capture: &capture,
    })
    .await
    .expect("second");
    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert_eq!(first.thread_id, "thread-1");
    assert_eq!(first.created_at, CREATED);
    assert_eq!(
        first.id,
        format!("{}1", checkpoint_prefix("thread-1").expect("prefix"))
    );
    // The tree is the snapshot's: HEAD's tree for an unmodified checkout.
    let head = String::from_utf8_lossy(
        &port
            .run(Command::new(&harness.root, &["rev-parse", "HEAD^{tree}"]))
            .await
            .expect("rev-parse")
            .stdout,
    )
    .trim_end()
    .to_owned();
    assert_eq!(first.tree, head);
    // The counter ref names the last checkpoint's commit.
    let counter = port
        .run(Command::new(
            &harness.root,
            &["rev-parse", &counter_ref("thread-1").expect("ref")],
        ))
        .await
        .expect("counter")
        .stdout;
    assert_eq!(String::from_utf8_lossy(&counter).trim_end(), second.sha);
}

#[tokio::test]
async fn a_stale_cached_counter_is_retried_instead_of_overwritten() {
    let harness = Harness::new("create-race");
    let context = harness.context();
    let port = harness.port();
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let mut writer = CheckpointNumbers::default();
    for _ in 0..2 {
        create_checkpoint(CreateCheckpoint {
            port: &port,
            context: &context,
            numbers: &mut writer,
            wait: &TokioWait,
            root: &harness.root,
            thread_id: "thread-1",
            label: "other",
            ownership: None,
            capture: &capture,
        })
        .await
        .expect("other writer");
    }
    // A second allocator saw the thread before any counter existed.
    let mut stale = CheckpointNumbers::default();
    stale.remember(
        &harness.root,
        "thread-1",
        Counter {
            sha: None,
            sequence: 0,
        },
    );
    let checkpoint = create_checkpoint(CreateCheckpoint {
        port: &port,
        context: &context,
        numbers: &mut stale,
        wait: &NoWait,
        root: &harness.root,
        thread_id: "thread-1",
        label: "mine",
        ownership: None,
        capture: &capture,
    })
    .await
    .expect("created after the race");
    // The compare-and-swap failed, the counter was refreshed, and sequence 3 was allocated.
    assert_eq!(checkpoint.sequence, 3);
    let listed = list_checkpoints(&port, &harness.root, "thread-1")
        .await
        .expect("listed");
    assert_eq!(
        listed
            .iter()
            .map(|entry| entry.sequence)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
}

#[tokio::test]
async fn a_checkpoint_reads_by_its_ref_id_and_refuses_an_unknown_one() {
    let harness = Harness::new("create-read");
    let context = harness.context();
    let port = harness.port();
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let mut numbers = CheckpointNumbers::default();
    let created = create_checkpoint(CreateCheckpoint {
        port: &port,
        context: &context,
        numbers: &mut numbers,
        wait: &TokioWait,
        root: &harness.root,
        thread_id: "thread-1",
        label: "before edit",
        ownership: None,
        capture: &capture,
    })
    .await
    .expect("created");
    assert_eq!(
        read_checkpoint(&port, &harness.root, &created.id)
            .await
            .expect("read"),
        created
    );
    let missing = format!("{}9", checkpoint_prefix("thread-1").expect("prefix"));
    assert_eq!(
        read_checkpoint(&port, &harness.root, &missing)
            .await
            .expect_err("refused")
            .code,
        GitErrorCode::CheckpointNotFound
    );
    assert_eq!(
        read_checkpoint(&port, &harness.root, "not-an-id")
            .await
            .expect_err("refused")
            .code,
        GitErrorCode::CheckpointNotFound
    );
}

#[tokio::test]
async fn deleting_a_thread_removes_its_refs_and_counter_and_restarts_at_one() {
    let harness = Harness::new("create-delete");
    let context = harness.context();
    let port = harness.port();
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let mut numbers = CheckpointNumbers::default();
    for _ in 0..2 {
        create_checkpoint(CreateCheckpoint {
            port: &port,
            context: &context,
            numbers: &mut numbers,
            wait: &TokioWait,
            root: &harness.root,
            thread_id: "thread-1",
            label: "checkpoint",
            ownership: None,
            capture: &capture,
        })
        .await
        .expect("created");
    }
    assert_eq!(
        delete_checkpoints(&port, &context, &mut numbers, &harness.root, "thread-1")
            .await
            .expect("deleted"),
        2
    );
    assert_eq!(
        list_checkpoints(&port, &harness.root, "thread-1")
            .await
            .expect("listed")
            .len(),
        0
    );
    // The counter is gone: the next checkpoint is the first again.
    let next = create_checkpoint(CreateCheckpoint {
        port: &port,
        context: &context,
        numbers: &mut numbers,
        wait: &TokioWait,
        root: &harness.root,
        thread_id: "thread-1",
        label: "fresh",
        ownership: None,
        capture: &capture,
    })
    .await
    .expect("created");
    assert_eq!(next.sequence, 1);
}

#[tokio::test]
async fn deleting_a_thread_without_a_counter_verifies_it_stayed_absent() {
    let harness = Harness::new("create-delete-empty");
    let context = harness.context();
    let port = harness.port();
    let mut numbers = CheckpointNumbers::default();
    // No checkpoints and no counter: the transaction verifies the counter's zero id, which is
    // how Git says "and it must still not exist".
    assert_eq!(
        delete_checkpoints(&port, &context, &mut numbers, &harness.root, "thread-empty")
            .await
            .expect("deleted"),
        0
    );
    assert_eq!(
        delete_checkpoints(
            &port,
            &context,
            &mut CheckpointNumbers::default(),
            &harness.root,
            "thread-empty"
        )
        .await
        .expect("deleted again"),
        0
    );
}

#[test]
fn the_retry_pauses_and_the_lock_reading_are_the_typescripts() {
    assert_eq!(retry_pause_ms(0), 25);
    assert_eq!(retry_pause_ms(5), 150);
    assert_eq!(retry_pause_ms(9), 250);
    assert_eq!(retry_pause_ms(19), 250);
    assert!(ref_locked(
        "error: cannot lock ref 'refs/ace/checkpoint-sequences/t': Unable to create '.../x.lock': File exists."
    ));
    assert!(!ref_locked("fatal: update_ref failed"));
    assert!(!ref_locked("error: cannot lock ref 'x': File exists"));
    let _: Option<Checkpoint> = None;
}
