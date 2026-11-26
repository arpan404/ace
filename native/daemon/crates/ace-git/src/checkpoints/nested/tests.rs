// SPDX-License-Identifier: Apache-2.0
//! The nested checkout rules (`nested.ts`): who owns discovery, which `.git` is a repository, and
//! what a nested root must be. Every case runs real Git in a fixture checkout.

use super::{
    Ownership, ignored_paths, nested_checkouts, nested_root, owned_children, repository_paths,
};
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitErrorCode;
use crate::parse::index::parse_index;
use crate::reads::test_support::ProcessCommands;
use crate::reads::{Command, CommandPort};

#[tokio::test]
async fn discovery_returns_the_top_most_repositories_only() {
    let fixture = Fixture::new("nested-top");
    let repo = fixture.repository("repo");
    fixture.repository("repo/outer");
    fixture.repository("repo/outer/inner");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    // A nested repository below another one is that repository's, not this one's.
    let candidates = vec![
        String::from("outer"),
        String::from("outer/inner"),
        String::from("file.txt"),
    ];
    assert_eq!(
        repository_paths(&root, candidates).expect("paths"),
        ["outer"]
    );
}

#[tokio::test]
async fn a_nested_refuses_a_path_that_is_not_its_own_root() {
    let fixture = Fixture::new("nested-root");
    let repo = fixture.repository("repo");
    fixture.repository("repo/inner");
    std::fs::create_dir_all(repo.join("inner/deep")).expect("deep");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let port = ProcessCommands { fixture: &fixture };
    // A path inside a repository is not a repository root.
    let error = nested_root(&port, &root, "inner/deep")
        .await
        .expect_err("refused");
    assert_eq!(error.code, GitErrorCode::NotARepo);
    assert_eq!(error.message, "Nested path is not a repository root");
    // The nested root itself answers its real path.
    let canonical = std::fs::canonicalize(repo.join("inner")).expect("canonical");
    assert_eq!(
        nested_root(&port, &root, "inner").await.expect("root"),
        canonical.to_string_lossy()
    );
}

#[tokio::test]
async fn nested_checkouts_exclude_a_linked_worktree_of_the_same_repository() {
    let fixture = Fixture::new("nested-linked");
    let repo = fixture.repository("repo");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
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
    fixture.repository("repo/inner");
    let port = ProcessCommands { fixture: &fixture };
    // The nested repositories are discovered from the tracked set; the linked worktree is
    // a checkout of this history, not a repository below it.
    let tracked = parse_index(
        &port
            .run(Command::new(&root, &["ls-files", "--stage", "-z"]))
            .await
            .expect("ls-files")
            .stdout,
    )
    .expect("index");
    let found = nested_checkouts(&port, &root, &tracked, &[])
        .await
        .expect("nested");
    assert_eq!(found.repositories, ["inner"]);
    assert_eq!(found.linked, ["wt"]);
}

#[tokio::test]
async fn ignored_paths_include_each_nested_repositorys_own_and_its_git_directory() {
    let fixture = Fixture::new("nested-ignored");
    let repo = fixture.repository("repo");
    let nested = fixture.repository("repo/inner");
    std::fs::write(repo.join(".gitignore"), "*.log\n").expect("gitignore");
    std::fs::write(repo.join("root.log"), "ignored\n").expect("log");
    std::fs::write(nested.join(".gitignore"), "*.tmp\n").expect("gitignore");
    std::fs::write(nested.join("inner.tmp"), "ignored\n").expect("tmp");
    let root = std::fs::canonicalize(&repo)
        .expect("root")
        .to_string_lossy()
        .into_owned();
    let port = ProcessCommands { fixture: &fixture };
    let mut ownership = Ownership::new();
    ownership.insert(root.clone(), vec![String::from("inner")]);
    let inner = std::fs::canonicalize(repo.join("inner"))
        .expect("inner")
        .to_string_lossy()
        .into_owned();
    ownership.insert(inner, Vec::new());
    let ignored = ignored_paths(&port, &root, &[], Some(&ownership))
        .await
        .expect("ignored");
    assert!(ignored.contains(&String::from("root.log")));
    assert!(
        ignored.contains(&String::from("inner/.git")),
        "administrative data is never replaced: {ignored:?}"
    );
    assert!(
        ignored.contains(&String::from("inner/inner.tmp")),
        "a nested repository's own ignores apply under its path: {ignored:?}"
    );
    // Discovery without ownership finds the same nested repository.
    let ignored = ignored_paths(&port, &root, &[], None)
        .await
        .expect("ignored");
    assert!(ignored.contains(&String::from("inner/inner.tmp")));
    // A root outside the ownership is refused rather than guessed at.
    assert_eq!(
        owned_children(&Ownership::new(), &root)
            .expect_err("refused")
            .message,
        "Snapshot root is outside restore ownership"
    );
}
