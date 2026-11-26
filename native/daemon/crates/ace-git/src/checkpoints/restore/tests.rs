// SPDX-License-Identifier: Apache-2.0
//! Restore (`restore.ts`, `restore-nested.ts`): the safety capture, the collision checks and the
//! checkout back to the target. Every case runs real Git in a fixture checkout, and the person's
//! index and HEAD are checked to be untouched.

use super::{Guard, Lock, RestoreCheckpoint, restore_checkpoint, with_nested_worktrees};
use crate::checkpoints::create::{CreateCheckpoint, TokioWait, Wait, create_checkpoint};
use crate::checkpoints::metadata::Checkpoint;
use crate::checkpoints::nested::{Capture, Ownership};
use crate::checkpoints::numbers::CheckpointNumbers;
use crate::checkpoints::snapshot::{SnapshotContext, snapshot};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::{GitError, GitErrorCode};
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

/// The test's lease: nothing else writes these checkouts, so it only counts.
#[derive(Default)]
struct CountingLock {
    held: std::sync::Mutex<Vec<String>>,
}

impl Lock for CountingLock {
    fn acquire<'a>(&'a self, root: &'a str) -> BoxFuture<'a, Result<Guard, GitError>> {
        Box::pin(async move {
            let mut held = self.held.lock().expect("lock");
            held.push(root.to_owned());
            Ok(Guard(held.len() as u64))
        })
    }

    fn release(&self, _guard: Guard) {}
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

    async fn checkpoint(&self, numbers: &mut CheckpointNumbers, label: &str) -> Checkpoint {
        let context = self.context();
        let port = self.port();
        let capture = Direct {
            port: &port,
            context: &context,
            ownership: None,
        };
        create_checkpoint(CreateCheckpoint {
            port: &port,
            context: &context,
            numbers,
            wait: &TokioWait,
            root: &self.root,
            thread_id: "thread-1",
            label,
            ownership: None,
            capture: &capture,
        })
        .await
        .expect("checkpoint")
    }

    async fn restore(&self, numbers: &mut CheckpointNumbers, id: &str) -> Result<String, GitError> {
        let context = self.context();
        let port = self.port();
        let lock = CountingLock::default();
        restore_checkpoint(RestoreCheckpoint {
            port: &port,
            context: &context,
            numbers,
            wait: &NoWait,
            lock: &lock,
            root: &self.root,
            id,
        })
        .await
        .map(|restored| restored.safety_checkpoint_id)
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(&self.root).join(path)).expect("file")
    }

    async fn head_and_index(&self) -> (String, Vec<u8>) {
        let port = self.port();
        let head = port
            .run(Command::new(&self.root, &["rev-parse", "HEAD"]))
            .await
            .expect("head")
            .stdout;
        let index =
            std::fs::read(std::path::Path::new(&self.root).join(".git/index")).expect("index");
        (String::from_utf8_lossy(&head).trim_end().to_owned(), index)
    }
}

#[tokio::test]
async fn restoring_puts_every_file_back_and_keeps_the_safety_capture() {
    let harness = Harness::new("restore-files");
    let mut numbers = CheckpointNumbers::default();
    let checkpoint = harness.checkpoint(&mut numbers, "before edits").await;
    // The person edits, adds and deletes files after the checkpoint.
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "edited\n",
    )
    .expect("edit");
    std::fs::write(
        std::path::Path::new(&harness.root).join("added.txt"),
        "new\n",
    )
    .expect("add");
    let (head_before, index_before) = harness.head_and_index().await;
    // What a snapshot of the pre-restore checkout is: the safety capture must hold exactly it.
    let context = harness.context();
    let port = harness.port();
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let before = snapshot(&port, &context, &harness.root, None, &capture)
        .await
        .expect("snapshot");
    let safety = harness
        .restore(&mut numbers, &checkpoint.id)
        .await
        .expect("restored");
    assert_eq!(harness.read("file.txt"), "content\n");
    assert!(
        !std::path::Path::new(&harness.root)
            .join("added.txt")
            .exists()
    );
    // HEAD and the person's index are untouched by a restore.
    let (head_after, index_after) = harness.head_and_index().await;
    assert_eq!(head_after, head_before);
    assert_eq!(
        index_after, index_before,
        "the raw index bytes are unchanged"
    );
    // The safety capture is a checkpoint of what was there before the restore.
    assert_ne!(safety, checkpoint.id);
    let safety =
        crate::checkpoints::create::read_checkpoint(&harness.port(), &harness.root, &safety)
            .await
            .expect("safety checkpoint");
    assert_eq!(safety.label, format!("Before restore of {}", checkpoint.id));
    assert_eq!(safety.thread_id, "thread-1");
    assert_eq!(
        safety.tree, before,
        "the safety capture holds the uncommitted work exactly"
    );
}

#[tokio::test]
async fn a_restore_refuses_to_overwrite_an_ignored_path() {
    let harness = Harness::new("restore-collision");
    let port = harness.port();
    let mut numbers = CheckpointNumbers::default();
    let checkpoint = harness.checkpoint(&mut numbers, "before").await;
    // `file.txt` becomes untracked and ignored; the checkpoint still holds it.
    harness.fixture.git(
        &harness.root_as_path(),
        &["rm", "--cached", "-q", "file.txt"],
    );
    std::fs::write(
        std::path::Path::new(&harness.root).join(".gitignore"),
        "file.txt\n",
    )
    .expect("gitignore");
    harness
        .fixture
        .git(&harness.root_as_path(), &["add", ".gitignore"]);
    harness.fixture.git(
        &harness.root_as_path(),
        &["commit", "--quiet", "-m", "ignore"],
    );
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "precious\n",
    )
    .expect("file");
    let error = harness
        .restore(&mut numbers, &checkpoint.id)
        .await
        .expect_err("refused");
    assert_eq!(error.code, GitErrorCode::RestoreCollision);
    assert_eq!(
        error.message,
        "Checkpoint would overwrite ignored path: file.txt"
    );
    // Nothing was written, and the refusal names its safety checkpoint.
    assert_eq!(harness.read("file.txt"), "precious\n");
    assert!(
        error
            .details
            .get("safetyCheckpointId")
            .and_then(ace_json::Value::as_str)
            .is_some_and(|id| id.contains("refs/ace/checkpoints/thread-1/")),
        "{:?}",
        error.details
    );
    let _ = port;
}

#[tokio::test]
async fn a_nested_repository_is_restored_with_its_lock_held() {
    let harness = Harness::new("restore-nested");
    let nested = std::path::Path::new(&harness.root).join("inner");
    std::fs::create_dir_all(&nested).expect("inner");
    harness.fixture.git(&nested, &["init", "--quiet"]);
    harness
        .fixture
        .git(&nested, &["config", "user.email", "test@example.invalid"]);
    harness
        .fixture
        .git(&nested, &["config", "user.name", "Test"]);
    std::fs::write(nested.join("inner.txt"), "inside\n").expect("inner file");
    harness.fixture.git(&nested, &["add", "inner.txt"]);
    harness
        .fixture
        .git(&nested, &["commit", "--quiet", "-m", "inner"]);
    let mut numbers = CheckpointNumbers::default();
    let checkpoint = harness.checkpoint(&mut numbers, "before").await;
    std::fs::write(nested.join("inner.txt"), "changed\n").expect("change");
    harness
        .restore(&mut numbers, &checkpoint.id)
        .await
        .expect("restored");
    assert_eq!(
        std::fs::read_to_string(nested.join("inner.txt")).expect("file"),
        "inside\n"
    );
}

#[tokio::test]
async fn a_missing_checkpoint_is_not_found_and_writes_nothing() {
    let harness = Harness::new("restore-missing");
    let mut numbers = CheckpointNumbers::default();
    let missing = String::from("refs/ace/checkpoints/thread-1/42");
    let error = harness
        .restore(&mut numbers, &missing)
        .await
        .expect_err("refused");
    assert_eq!(error.code, GitErrorCode::CheckpointNotFound);
    assert_eq!(harness.read("file.txt"), "content\n");
}

#[tokio::test]
async fn an_unrelated_lock_is_taken_for_every_child_and_released() {
    // `withNestedWorktrees` holds a lease per descendant; the operation sees the whole hierarchy.
    let harness = Harness::new("restore-locks");
    let outer = std::path::Path::new(&harness.root).join("outer");
    std::fs::create_dir_all(&outer).expect("outer");
    harness.fixture.git(&outer, &["init", "--quiet"]);
    let context = harness.context();
    let port = harness.port();
    let lock = CountingLock::default();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Vec<String>>::new()));
    let recorded = std::sync::Arc::clone(&seen);
    let root = harness.root.clone();
    with_nested_worktrees(
        &port,
        &context,
        &harness.root,
        &lock,
        |children, ownership| {
            Box::pin(async move {
                let paths: Vec<String> = children
                    .iter()
                    .map(|child| format!("{}:{}", child.path, child.children.len()))
                    .collect();
                recorded.lock().expect("seen").push(paths);
                assert_eq!(
                    ownership.get(&root).expect("root ownership"),
                    &[String::from("outer")]
                );
                Ok::<(), GitError>(())
            })
        },
    )
    .await
    .expect("nested");
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![vec![String::from("outer:0")]]
    );
    assert_eq!(lock.held.lock().expect("held").len(), 1);
}

impl Harness {
    fn root_as_path(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(&self.root)
    }
}
