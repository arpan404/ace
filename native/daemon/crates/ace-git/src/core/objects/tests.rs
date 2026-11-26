// SPDX-License-Identifier: Apache-2.0
//! Object transfer between checkouts (`object-transfer.ts`): the tree arrives whole, with the
//! bytes Git wrote, in a repository that had none of it.

use super::{transfer_objects, transfer_tree};
use crate::core::credentials::test_support::Fixture;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

#[tokio::test]
async fn a_tree_and_its_objects_arrive_in_another_repository() {
    let fixture = Fixture::new("objects-transfer");
    let from = fixture.repository("from");
    std::fs::write(from.join("file.txt"), "changed\n").expect("file");
    fixture.git(&from, &["add", "file.txt"]);
    fixture.git(&from, &["commit", "--quiet", "-m", "second"]);
    let to = fixture.repository("to");
    let from = from.to_string_lossy().into_owned();
    let to = to.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let tree = text(
        &port
            .run(Command::new(&from, &["rev-parse", "HEAD^{tree}"]))
            .await
            .expect("rev-parse")
            .stdout,
    );
    transfer_tree(&port, &from, &to, &tree, "2026-11-26T09:00:00.000Z")
        .await
        .expect("transfer");
    // The target can read the tree and its blob now.
    let listing = port
        .run(Command::new(&to, &["ls-tree", "-r", "-z", &tree]))
        .await
        .expect("ls-tree");
    let entries = crate::parse::index::parse_tree(&listing.stdout).expect("tree");
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        ["file.txt"]
    );
    let blob = port
        .run(Command::new(
            &to,
            &["cat-file", "blob", &format!("{tree}:file.txt")],
        ))
        .await
        .expect("cat-file");
    assert_eq!(text(&blob.stdout), "changed");
}

#[tokio::test]
async fn transferring_a_commit_carries_everything_it_reaches() {
    let fixture = Fixture::new("objects-commit");
    let from = fixture.repository("from");
    let to = fixture.repository("to");
    let from = from.to_string_lossy().into_owned();
    let to = to.to_string_lossy().into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let commit = text(
        &port
            .run(Command::new(&from, &["rev-parse", "HEAD"]))
            .await
            .expect("rev-parse")
            .stdout,
    );
    transfer_objects(&port, &from, &to, &commit)
        .await
        .expect("transfer");
    let kind = port
        .run(Command::new(&to, &["cat-file", "-t", &commit]))
        .await
        .expect("cat-file");
    assert_eq!(text(&kind.stdout), "commit");
}
