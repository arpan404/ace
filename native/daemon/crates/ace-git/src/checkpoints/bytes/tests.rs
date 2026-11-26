// SPDX-License-Identifier: Apache-2.0
//! A checkpoint's exact bytes (`checkpoint-bytes.ts`): the tree Git stores keeps its conversions,
//! the bytes ref keeps what is on disk, and a restore writes the latter. Every case runs real Git;
//! only the callers that use them are platform-gated.

use super::{
    bytes_prefix, bytes_tree, checkpoint_bytes, exact_checkout_args, forget_bytes, quoted,
    record_bytes,
};
use crate::checkpoints::metadata::{CHECKPOINT_FORMAT, Checkpoint};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitErrorCode;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

const CREATED: &str = "2026-11-26T09:00:00.000Z";

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

/// A blob's bytes exactly: `text` trims the newline a command's output ends with, a blob's bytes
/// are its own.
fn raw(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

async fn run(port: &dyn CommandPort, cwd: &str, args: &[&str]) -> crate::reads::CommandOutput {
    port.run(Command::new(cwd, args)).await.expect("command")
}

#[tokio::test]
async fn a_tree_that_converts_line_endings_gets_a_bytes_tree_of_what_is_on_disk() {
    let fixture = Fixture::new("bytes-tree");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    std::fs::write(repo.join(".gitattributes"), "* text=auto\n").expect("attributes");
    std::fs::write(repo.join("crlf.txt"), "a\r\nb\r\n").expect("crlf");
    // Git stores the normalised blob; the checkout keeps the CRLF bytes.
    fixture.git(&repo, &["add", ".gitattributes", "crlf.txt"]);
    let tree = text(&fixture.git(&repo, &["write-tree"]));
    let port = ProcessCommands { fixture: &fixture };
    let stored = raw(&run(
        &port,
        &root,
        &["cat-file", "blob", &format!("{tree}:crlf.txt")],
    )
    .await
    .stdout);
    assert_eq!(stored, "a\nb\n", "the tree's blob is normalised");
    let bytes = bytes_tree(&port, &root, &root, &tree)
        .await
        .expect("bytes tree");
    assert_ne!(bytes, tree);
    let exact = raw(&run(
        &port,
        &root,
        &["cat-file", "blob", &format!("{bytes}:crlf.txt")],
    )
    .await
    .stdout);
    assert_eq!(exact, "a\r\nb\r\n", "the bytes are the checkout's own");
    // The unchanged files keep their rows: only the file whose bytes differ moved.
    let listing = run(&port, &root, &["ls-tree", "-r", &bytes]).await;
    assert!(text(&listing.stdout).contains(".gitattributes"));
}

#[tokio::test]
async fn a_tree_whose_bytes_are_already_its_blobs_is_returned_unchanged() {
    let fixture = Fixture::new("bytes-same");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let tree = text(&fixture.git(&repo, &["rev-parse", "HEAD^{tree}"]));
    let port = ProcessCommands { fixture: &fixture };
    assert_eq!(
        bytes_tree(&port, &root, &root, &tree)
            .await
            .expect("bytes tree"),
        tree
    );
}

#[tokio::test]
async fn a_checkpoints_bytes_fall_back_to_its_tree_when_none_were_recorded() {
    let fixture = Fixture::new("bytes-fallback");
    let repo = fixture.repository("repo");
    std::fs::write(repo.join("crlf.txt"), "a\r\nb\r\n").expect("crlf");
    fixture.git(&repo, &["add", "crlf.txt"]);
    let tree = text(&fixture.git(&repo, &["write-tree"]));
    let sha = text(&fixture.git(&repo, &["commit-tree", &tree, "-m", "checkpoint"]));
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let bytes = bytes_tree(&port, &root, &root, &tree)
        .await
        .expect("bytes tree");
    let checkpoint = Checkpoint {
        id: String::from("refs/ace/checkpoints/thread-1/1"),
        sha: sha.clone(),
        tree: tree.clone(),
        thread_id: String::from("thread-1"),
        sequence: 1,
        label: String::from("snapshot"),
        created_at: String::from(CREATED),
    };
    assert_eq!(
        checkpoint_bytes(&port, &root, &checkpoint)
            .await
            .expect("bytes"),
        tree
    );
    record_bytes(&port, &root, "thread-1", &sha, &bytes, CREATED)
        .await
        .expect("record");
    assert_eq!(
        checkpoint_bytes(&port, &root, &checkpoint)
            .await
            .expect("bytes"),
        bytes
    );
    // The ref is named for the checkpoint commit.
    let reference = format!("{}{sha}", bytes_prefix("thread-1").expect("prefix"));
    let found = run(&port, &root, &["rev-parse", "--verify", &reference]).await;
    assert_eq!(found.exit_code, 0);
}

#[tokio::test]
async fn forgetting_a_thread_drops_only_the_refs_of_checkpoints_it_no_longer_has() {
    let fixture = Fixture::new("bytes-forget");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let tree = text(&fixture.git(&repo, &["rev-parse", "HEAD^{tree}"]));
    let port = ProcessCommands { fixture: &fixture };
    let keep = text(&fixture.git(&repo, &["commit-tree", &tree, "-m", "keep"]));
    let drop = text(&fixture.git(&repo, &["commit-tree", &tree, "-m", "drop"]));
    strict(
        &port,
        &root,
        &["update-ref", "refs/ace/checkpoints/thread-1/1", &keep],
    )
    .await;
    record_bytes(&port, &root, "thread-1", &keep, &tree, CREATED)
        .await
        .expect("record keep");
    record_bytes(&port, &root, "thread-1", &drop, &tree, CREATED)
        .await
        .expect("record drop");
    forget_bytes(&port, &root, "thread-1")
        .await
        .expect("forget");
    let live = format!("{}{keep}", bytes_prefix("thread-1").expect("prefix"));
    let stale = format!("{}{drop}", bytes_prefix("thread-1").expect("prefix"));
    assert_eq!(
        run(&port, &root, &["rev-parse", "--verify", "--quiet", &live])
            .await
            .exit_code,
        0
    );
    assert_ne!(
        run(&port, &root, &["rev-parse", "--verify", "--quiet", &stale])
            .await
            .exit_code,
        0,
        "the dropped checkpoint's bytes are gone"
    );
}

async fn strict(port: &dyn CommandPort, root: &str, args: &[&str]) {
    let output = port
        .run(Command::new(root, args).writing())
        .await
        .expect("command");
    assert_eq!(output.exit_code, 0, "{}", output.stderr);
}

#[test]
fn a_path_survives_gits_line_quoting() {
    assert_eq!(quoted("plain.txt"), "\"plain.txt\"");
    assert_eq!(quoted("a\"b"), "\"a\\\"b\"");
    assert_eq!(quoted("a\\b"), "\"a\\\\b\"");
    assert_eq!(quoted("a\tb"), "\"a\\011b\"");
    assert_eq!(quoted("é.txt"), "\"é.txt\"");
}

#[tokio::test]
async fn exact_checkout_args_use_an_attributes_source_when_git_has_one() {
    let fixture = Fixture::new("bytes-exact");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let args = exact_checkout_args(&port, &root).await.expect("args");
    let Some(args) = args else {
        return; // A Git older than 2.41 has no `--attr-source`; the TypeScript answers the same.
    };
    assert!(
        args[args.len() - 1].starts_with("--attr-source="),
        "{args:?} switches every conversion off"
    );
    assert!(args.iter().any(|arg| arg == "core.autocrlf=false"));
    assert!(args.iter().any(|arg| arg == "core.eol=lf"));
    assert!(args.iter().any(|arg| arg == "core.safecrlf=false"));
    // The neutral attributes leave `text` unspecified, so no path converts.
    let tree = args[args.len() - 1].trim_start_matches("--attr-source=");
    let attributes = run(
        &port,
        &root,
        &["cat-file", "blob", &format!("{tree}:.gitattributes")],
    )
    .await;
    assert_eq!(
        text(&attributes.stdout),
        "* -text -filter -ident -working-tree-encoding"
    );
}

#[tokio::test]
async fn a_malformed_bytes_ref_is_refused() {
    let fixture = Fixture::new("bytes-malformed");
    let repo = fixture.repository("repo");
    let root = repo.to_string_lossy().into_owned();
    let checkpoint = Checkpoint {
        id: String::from("refs/ace/checkpoints/bad/1"),
        sha: "a".repeat(40),
        tree: "b".repeat(40),
        thread_id: String::from("bad/thread"),
        sequence: 1,
        label: String::from("l"),
        created_at: String::from(CREATED),
    };
    let port = ProcessCommands { fixture: &fixture };
    assert_eq!(
        checkpoint_bytes(&port, &root, &checkpoint)
            .await
            .expect_err("refused")
            .code,
        GitErrorCode::InvalidArgument
    );
    assert_eq!(CHECKPOINT_FORMAT, "ace-checkpoint-v1");
}
