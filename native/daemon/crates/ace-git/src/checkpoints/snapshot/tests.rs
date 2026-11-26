// SPDX-License-Identifier: Apache-2.0
//! The snapshot, S1–S13 (`snapshot-index.ts`, `checkpoints.ts`'s `snapshot`): the tree is the
//! checkout's bytes as Git sees them — tracked, untracked and ignored apart, nested repositories
//! flattened, linked worktrees left out, gitlinks refused. Every case runs real Git.

use std::path::Path;

use super::{SnapshotContext, snapshot};
use crate::checkpoints::nested::{Capture, Ownership, owned_children};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::spawn::BoxFuture;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

const CREATED: &str = "2026-11-26T09:00:00.000Z";

/// The snapshot a nested root gets through `flattenNested`: the same ownership map, so a
/// restore's children stay the set captured.
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

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

async fn tree_paths(port: &dyn CommandPort, root: &str, tree: &str) -> Vec<(String, String)> {
    let output = port
        .run(Command::new(root, &["ls-tree", "-r", "-z", tree]))
        .await
        .expect("ls-tree");
    crate::parse::index::parse_tree(&output.stdout)
        .expect("tree")
        .into_iter()
        .map(|entry| (entry.path, entry.mode))
        .collect()
}

async fn blob(port: &dyn CommandPort, root: &str, tree: &str, path: &str) -> String {
    let output = port
        .run(Command::new(
            root,
            &["cat-file", "blob", &format!("{tree}:{path}")],
        ))
        .await
        .expect("cat-file");
    text(&output.stdout)
}

#[tokio::test]
async fn a_snapshot_holds_tracked_and_untracked_files_and_leaves_ignored_ones_out() {
    let fixture = Fixture::new("snapshot-files");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    std::fs::write(repo.join(".gitignore"), "*.log\n").expect("gitignore");
    std::fs::write(repo.join("new.txt"), "untracked\n").expect("untracked");
    std::fs::write(repo.join("noise.log"), "ignored\n").expect("ignored");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let tree = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    let paths = tree_paths(&port, &root, &tree).await;
    let names: Vec<&str> = paths.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(names, [".gitignore", "file.txt", "new.txt"]);
    assert_eq!(blob(&port, &root, &tree, "new.txt").await, "untracked");
    // The person's index is untouched: the snapshot used a temporary one.
    let index = port
        .run(Command::new(&root, &["ls-files", "--stage", "-z"]))
        .await
        .expect("ls-files");
    assert!(!text(&index.stdout).contains("new.txt"));
    // Nothing of the temporary index survives.
    let left: Vec<_> = std::fs::read_dir(&root)
        .expect("root")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("ace-git-index-")
        })
        .collect();
    assert!(left.is_empty(), "the temporary index is removed");
}

#[tokio::test]
async fn a_nested_repository_is_flattened_into_the_parent_tree() {
    let fixture = Fixture::new("snapshot-nested");
    let repo = fixture.repository("repo");
    let nested = fixture.repository("repo/inner");
    std::fs::write(nested.join("inner.txt"), "inside\n").expect("nested file");
    fixture.git(&nested, &["add", "inner.txt"]);
    fixture.git(&nested, &["commit", "--quiet", "-m", "inner"]);
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let tree = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    let paths = tree_paths(&port, &root, &tree).await;
    // The nested repository's files are the parent's files, under its path; no gitlink remains.
    assert_eq!(
        paths
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        ["file.txt", "inner/file.txt", "inner/inner.txt"]
    );
    assert_eq!(blob(&port, &root, &tree, "inner/inner.txt").await, "inside");
    assert!(paths.iter().all(|(_, mode)| mode != "160000"));
}

#[tokio::test]
async fn a_linked_worktree_inside_the_checkout_is_left_out_entirely() {
    let fixture = Fixture::new("snapshot-linked");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    // A linked worktree of this repository lives inside the checkout.
    let linked = repo.join("wt");
    fixture.git(
        &repo,
        &[
            "worktree",
            "add",
            "--quiet",
            &linked.to_string_lossy(),
            "-b",
            "side",
        ],
    );
    std::fs::write(linked.join("side.txt"), "side\n").expect("side file");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let tree = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    let paths = tree_paths(&port, &root, &tree).await;
    assert_eq!(
        paths
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        ["file.txt"],
        "the linked worktree is another checkout, not this one's state"
    );
}

#[tokio::test]
async fn a_sparse_checkout_is_refused_before_anything_is_written() {
    let fixture = Fixture::new("snapshot-sparse");
    let repo = fixture.repository("repo");
    fixture.git(&repo, &["config", "core.sparseCheckout", "true"]);
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let error = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect_err("refused");
    assert_eq!(error.code, GitErrorCode::UnsupportedRepository);
    assert_eq!(
        error.message,
        "Full working-tree snapshots do not support sparse checkout"
    );
}

#[tokio::test]
async fn a_gitlink_row_is_removed_and_never_written_into_the_tree() {
    let fixture = Fixture::new("snapshot-gitlink");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    let head = text(&fixture.git(&repo, &["rev-parse", "HEAD"]));
    fixture.git(
        &repo,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},sub"),
        ],
    );
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let tree = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    let paths = tree_paths(&port, &root, &tree).await;
    assert_eq!(
        paths
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        ["file.txt"],
        "the gitlink is gone, not refused, because nothing survives it"
    );
}

#[tokio::test]
async fn a_root_outside_the_owned_children_is_refused() {
    let fixture = Fixture::new("snapshot-unowned");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let ownership = Ownership::new();
    assert_eq!(
        owned_children(&ownership, &root)
            .expect_err("refused")
            .message,
        "Snapshot root is outside restore ownership"
    );
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: Some(&ownership),
    };
    let error = snapshot(&port, &context, &root, Some(&ownership), &capture)
        .await
        .expect_err("refused");
    assert_eq!(error.code, GitErrorCode::UnsupportedRepository);
    // The ownership names the root: it snapshots.
    let mut ownership = Ownership::new();
    ownership.insert(root.clone(), Vec::new());
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: Some(&ownership),
    };
    assert!(
        snapshot(&port, &context, &root, Some(&ownership), &capture)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn the_snapshot_is_the_checkout_not_the_index_it_started_from() {
    let fixture = Fixture::new("snapshot-index");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    // The person staged a change but has not committed it: the snapshot is what is on disk.
    std::fs::write(repo.join("file.txt"), "staged\n").expect("file");
    fixture.git(&repo, &["add", "file.txt"]);
    std::fs::write(repo.join("file.txt"), "on disk\n").expect("file");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let tree = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    assert_eq!(blob(&port, &root, &tree, "file.txt").await, "on disk");
    // A path deleted on disk but still in HEAD is not in the snapshot.
    std::fs::remove_file(repo.join("file.txt")).expect("remove");
    let tree = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    assert!(
        !tree_paths(&port, &root, &tree)
            .await
            .iter()
            .any(|(path, _)| path == "file.txt")
    );
}

#[tokio::test]
async fn two_snapshots_of_an_unchanged_checkout_agree() {
    let fixture = Fixture::new("snapshot-stable");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let temp = fixture.root.join("tmp");
    std::fs::create_dir_all(&temp).expect("temp");
    let context = SnapshotContext {
        temp_directory: temp.to_string_lossy().into_owned(),
        platform: String::from("darwin"),
        now: Box::new(|| CREATED.to_owned()),
    };
    let port = ProcessCommands { fixture: &fixture };
    let capture = Direct {
        port: &port,
        context: &context,
        ownership: None,
    };
    let first = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    let second = snapshot(&port, &context, &root, None, &capture)
        .await
        .expect("snapshot");
    assert_eq!(first, second);
    assert_eq!(
        first,
        text(&fixture.git(&repo, &["rev-parse", "HEAD^{tree}"]))
    );
    assert!(Path::new(&root).is_dir());
}
