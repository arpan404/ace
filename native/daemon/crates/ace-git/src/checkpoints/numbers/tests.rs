// SPDX-License-Identifier: Apache-2.0
//! The sequence numbers (`checkpoint-numbers.ts`): the refs a thread owns, the durable counter
//! and its migration, and the bounded cache. Every read runs real Git in a fixture checkout.

use super::{CheckpointNumbers, Counter, DEFAULT_CAPACITY, checkpoint_refs, counter_ref};
use crate::checkpoints::metadata::{checkpoint_prefix, metadata_message};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitErrorCode;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

const CREATED: &str = "2026-11-26T09:00:00.000Z";

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

/// A commit whose message is the checkpoint metadata for `thread` at `sequence`.
async fn commit(port: &dyn CommandPort, repo: &str, thread: &str, sequence: u64) -> String {
    let tree = text(
        &port
            .run(Command::new(repo, &["rev-parse", "HEAD^{tree}"]))
            .await
            .expect("rev-parse")
            .stdout,
    );
    let message = metadata_message(thread, "snapshot", CREATED, sequence);
    let output = port
        .run(
            Command::new(repo, &["-c", "commit.gpgSign=false", "commit-tree", &tree])
                .writing()
                .with_input(format!("{message}\n").as_bytes()),
        )
        .await
        .expect("commit-tree");
    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    text(&output.stdout)
}

async fn set_ref(port: &dyn CommandPort, repo: &str, reference: &str, sha: &str) {
    let output = port
        .run(Command::new(repo, &["update-ref", reference, sha]).writing())
        .await
        .expect("update-ref");
    assert_eq!(output.exit_code, 0, "{}", output.stderr);
}

#[tokio::test]
async fn a_threads_refs_are_its_own_oldest_first() {
    let fixture = Fixture::new("numbers-refs");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    for sequence in [3_u64, 1, 2] {
        let sha = commit(&port, &root, "thread-1", sequence).await;
        let id = format!(
            "{}{sequence}",
            checkpoint_prefix("thread-1").expect("prefix")
        );
        set_ref(&port, &root, &id, &sha).await;
    }
    // Another thread's checkpoint and a branch are not this thread's refs.
    let other = commit(&port, &root, "thread-2", 9).await;
    set_ref(&port, &root, "refs/ace/checkpoints/thread-2/9", &other).await;

    let refs = checkpoint_refs(&port, &root, "thread-1")
        .await
        .expect("refs");
    assert_eq!(
        refs.iter()
            .map(|reference| (reference.sequence, reference.id.as_str()))
            .collect::<Vec<_>>(),
        [
            (1, "refs/ace/checkpoints/thread-1/1"),
            (2, "refs/ace/checkpoints/thread-1/2"),
            (3, "refs/ace/checkpoints/thread-1/3"),
        ]
    );
    // A thread with no checkpoints has none.
    assert!(
        checkpoint_refs(&port, &root, "thread-3")
            .await
            .expect("refs")
            .is_empty()
    );
}

#[tokio::test]
async fn a_thread_refused_by_git_is_not_read() {
    let fixture = Fixture::new("numbers-blank");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    assert_eq!(
        checkpoint_refs(&port, &root, "bad/thread")
            .await
            .expect_err("refused")
            .code,
        GitErrorCode::InvalidArgument
    );
}

#[tokio::test]
async fn the_counter_ref_names_the_last_sequence() {
    let fixture = Fixture::new("numbers-counter");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let shas: Vec<String> = {
        let mut shas = Vec::new();
        for sequence in [1_u64, 2] {
            shas.push(commit(&port, &root, "thread-1", sequence).await);
        }
        shas
    };
    set_ref(
        &port,
        &root,
        &counter_ref("thread-1").expect("ref"),
        &shas[1],
    )
    .await;

    let mut numbers = CheckpointNumbers::default();
    assert_eq!(
        numbers
            .get(&port, &root, "thread-1")
            .await
            .expect("counter"),
        Counter {
            sha: Some(shas[1].clone()),
            sequence: 2,
        }
    );
    // The read is cached: forget it and the next read goes back to Git.
    assert_eq!(numbers.size(), 1);
    numbers.forget(&root, "thread-1");
    assert_eq!(numbers.size(), 0);
}

#[tokio::test]
async fn a_thread_without_a_counter_migrates_from_its_last_checkpoint() {
    let fixture = Fixture::new("numbers-migration");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    for sequence in [2_u64, 4] {
        let sha = commit(&port, &root, "thread-1", sequence).await;
        let id = format!(
            "{}{sequence}",
            checkpoint_prefix("thread-1").expect("prefix")
        );
        set_ref(&port, &root, &id, &sha).await;
    }
    let mut numbers = CheckpointNumbers::default();
    assert_eq!(
        numbers
            .get(&port, &root, "thread-1")
            .await
            .expect("counter"),
        Counter {
            sha: None,
            sequence: 4,
        }
    );
    // A thread with no checkpoints starts at zero.
    assert_eq!(
        numbers
            .get(&port, &root, "thread-new")
            .await
            .expect("counter"),
        Counter {
            sha: None,
            sequence: 0,
        }
    );
}

#[tokio::test]
async fn a_counter_that_does_not_frame_or_parse_is_malformed() {
    let fixture = Fixture::new("numbers-malformed");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let reference = counter_ref("thread-1").expect("ref");
    let tree = text(
        &port
            .run(Command::new(&root, &["rev-parse", "HEAD^{tree}"]))
            .await
            .expect("rev-parse")
            .stdout,
    );

    // A message with no sequence cannot be a counter.
    let message = format!(
        r#"{{"format":"ace-checkpoint-v1","threadId":"thread-1","label":"l","createdAt":"{CREATED}"}}"#
    );
    let sha = text(
        &port
            .run(
                Command::new(&root, &["-c", "commit.gpgSign=false", "commit-tree", &tree])
                    .writing()
                    .with_input(format!("{message}\n").as_bytes()),
            )
            .await
            .expect("commit-tree")
            .stdout,
    );
    set_ref(&port, &root, &reference, &sha).await;
    let mut numbers = CheckpointNumbers::default();
    assert_eq!(
        numbers
            .refresh(&port, &root, "thread-1")
            .await
            .expect_err("refused")
            .code,
        GitErrorCode::MalformedOutput
    );

    // The counter's metadata names another thread.
    let sha = commit(&port, &root, "thread-9", 5).await;
    set_ref(&port, &root, &reference, &sha).await;
    assert_eq!(
        numbers
            .refresh(&port, &root, "thread-1")
            .await
            .expect_err("refused")
            .code,
        GitErrorCode::MalformedOutput
    );
}

#[tokio::test]
async fn the_counter_cache_keeps_at_most_its_capacity() {
    let mut numbers = CheckpointNumbers::new(DEFAULT_CAPACITY).expect("cache");
    for index in 0..=DEFAULT_CAPACITY {
        numbers.remember(
            &format!("/work/{index}"),
            "thread-1",
            Counter {
                sha: None,
                sequence: index as u64,
            },
        );
    }
    assert_eq!(numbers.size(), DEFAULT_CAPACITY);
    // The oldest entry was evicted: forgetting it changes nothing, the next one shrinks.
    numbers.forget("/work/0", "thread-1");
    assert_eq!(numbers.size(), DEFAULT_CAPACITY, "the first was evicted");
    numbers.forget("/work/1", "thread-1");
    assert_eq!(numbers.size(), DEFAULT_CAPACITY - 1);
    numbers.forget("/work/128", "thread-1");
    assert_eq!(numbers.size(), DEFAULT_CAPACITY - 2, "the newest was kept");
    // A budget outside 1..=4096 is refused, as `BoundedCache` refuses it.
    assert_eq!(
        CheckpointNumbers::new(0).expect_err("refused").code,
        GitErrorCode::InvalidArgument
    );
    assert_eq!(
        CheckpointNumbers::new(4_097).expect_err("refused").code,
        GitErrorCode::InvalidArgument
    );
}
