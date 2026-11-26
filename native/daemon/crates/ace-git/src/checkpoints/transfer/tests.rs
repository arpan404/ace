// SPDX-License-Identifier: Apache-2.0
//! `captureChanges` (`transfer-capture.ts`): uncommitted work as a commit at the caller's ref,
//! with the checkout and index untouched, and nothing when nothing changed.

use super::{CaptureOptions, Captured, capture_changes, head_commit, transfer_ref};
use crate::checkpoints::snapshot::SnapshotContext;
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitErrorCode;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

const CREATED: &str = "2026-11-26T09:00:00.000Z";
const REF: &str = "refs/ace/transfers/capture-1";

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
            now: Box::new(|| String::from(CREATED)),
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

    async fn capture(&self, options: CaptureOptions<'_>) -> Option<Captured> {
        let context = self.context();
        let port = self.port();
        capture_changes(
            &port,
            &context,
            &(|| String::from(CREATED)),
            &self.root,
            &options,
        )
        .await
        .expect("capture")
    }
}

#[tokio::test]
async fn uncommitted_work_becomes_a_commit_on_head_at_the_ref() {
    let harness = Harness::new("capture-changes");
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "edited\n",
    )
    .expect("edit");
    std::fs::write(std::path::Path::new(&harness.root).join("new.txt"), "new\n").expect("new");
    let head = harness.text(&["rev-parse", "HEAD"]);
    let captured = harness
        .capture(CaptureOptions {
            reference: REF,
            message: None,
        })
        .await
        .expect("a commit");
    assert_eq!(captured.head.as_deref(), Some(head.as_str()));
    // The ref names the commit, the commit's parent is HEAD, and the message is the default.
    assert_eq!(harness.text(&["rev-parse", REF]), captured.commit);
    assert_eq!(
        harness.text(&["rev-parse", &format!("{}^{{commit}}", captured.commit)]),
        captured.commit
    );
    assert_eq!(
        harness.text(&["log", "-1", "--format=%B", &captured.commit]),
        "Uncommitted changes"
    );
    // The captured tree holds the edit and the untracked file.
    let listing = harness.text(&["ls-tree", "-r", "--name-only", &captured.commit]);
    assert_eq!(listing, "file.txt\nnew.txt");
    // The person's checkout and index are untouched.
    assert_eq!(
        std::fs::read_to_string(std::path::Path::new(&harness.root).join("file.txt"))
            .expect("file"),
        "edited\n"
    );
    assert_eq!(harness.text(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(harness.text(&["rev-parse", "HEAD"]), head);
}

#[tokio::test]
async fn an_unchanged_checkout_captures_nothing() {
    let harness = Harness::new("capture-nothing");
    assert!(
        harness
            .capture(CaptureOptions {
                reference: REF,
                message: None
            })
            .await
            .is_none()
    );
    // An edit back to the committed bytes is the same tree, so still nothing.
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "content\n",
    )
    .expect("same");
    assert!(
        harness
            .capture(CaptureOptions {
                reference: REF,
                message: None
            })
            .await
            .is_none()
    );
}

#[tokio::test]
async fn the_message_is_the_callers_trimmed_or_the_default() {
    let harness = Harness::new("capture-message");
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "edited\n",
    )
    .expect("edit");
    let captured = harness
        .capture(CaptureOptions {
            reference: REF,
            message: Some("  handoff  \n"),
        })
        .await
        .expect("a commit");
    assert_eq!(
        harness.text(&["log", "-1", "--format=%B", &captured.commit]),
        "handoff"
    );
}

#[tokio::test]
async fn an_invalid_ref_is_refused_before_anything_is_written() {
    for bad in ["main", "refs/heads/../escape", "refs/heads/a b"] {
        let error = transfer_ref(bad).expect_err("refused");
        assert_eq!(error.code, GitErrorCode::InvalidRef);
        assert_eq!(error.message, format!("Invalid ref: {bad}"));
    }
    assert_eq!(transfer_ref(REF).as_deref(), Ok(REF));
}

#[tokio::test]
async fn an_untracked_nested_repository_stays_out_of_the_capture() {
    let harness = Harness::new("capture-nested");
    let nested = std::path::Path::new(&harness.root).join("inner");
    std::fs::create_dir_all(&nested).expect("inner");
    harness.fixture.git(&nested, &["init", "--quiet"]);
    std::fs::write(nested.join("inner.txt"), "inside\n").expect("inner file");
    std::fs::write(
        std::path::Path::new(&harness.root).join("file.txt"),
        "edited\n",
    )
    .expect("edit");
    let captured = harness
        .capture(CaptureOptions {
            reference: REF,
            message: None,
        })
        .await
        .expect("a commit");
    let listing = harness.text(&["ls-tree", "-r", "--name-only", &captured.commit]);
    assert_eq!(
        listing, "file.txt",
        "the nested repository is another checkout"
    );
}

#[tokio::test]
async fn an_unborn_checkout_captures_without_a_parent() {
    let harness = Harness::new("capture-unborn");
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
    assert_eq!(head_commit(&port, &root).await.expect("head"), None);
    let captured = capture_changes(
        &port,
        &context,
        &(|| String::from(CREATED)),
        &root,
        &CaptureOptions {
            reference: REF,
            message: None,
        },
    )
    .await
    .expect("capture")
    .expect("a commit");
    assert_eq!(captured.head, None);
    let parents = port
        .run(Command::new(
            &root,
            &["rev-list", "--parents", "-n", "1", &captured.commit],
        ))
        .await
        .expect("rev-list");
    assert_eq!(
        String::from_utf8_lossy(&parents.stdout).trim_end(),
        captured.commit,
        "no parent"
    );
}
