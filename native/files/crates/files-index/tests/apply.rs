// SPDX-License-Identifier: Apache-2.0

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use std::fs;

use files_index::IndexChange;
use support::{indexed, paths, write};

fn created(path: &str, directory: bool) -> IndexChange {
    IndexChange {
        path: path.to_owned(),
        deleted: false,
        directory,
    }
}

fn deleted(path: &str, directory: bool) -> IndexChange {
    IndexChange {
        path: path.to_owned(),
        deleted: true,
        directory,
    }
}

#[test]
fn apply_adds_and_removes_files() {
    let mut fixture = indexed(&["src/main.rs", "src/old.rs"]);
    write(fixture.dir.path(), "src/new.rs", "");
    fixture
        .index
        .apply(&fixture.root, &[created("src/new.rs", false)]);
    assert_eq!(paths(&fixture.index.search("new.rs", 5)), ["src/new.rs"]);
    assert_eq!(fixture.index.len(), 3);

    fixture
        .index
        .apply(&fixture.root, &[created("src/new.rs", false)]);
    assert_eq!(
        fixture.index.len(),
        3,
        "a repeated save is not a second file"
    );

    fs::remove_file(fixture.dir.path().join("src/old.rs")).expect("delete old.rs");
    fixture
        .index
        .apply(&fixture.root, &[deleted("src/old.rs", false)]);
    assert!(fixture.index.search("old.rs", 5).is_empty());
    assert_eq!(fixture.index.len(), 2);
}

#[test]
fn deleted_folder_drops_its_subtree() {
    let mut fixture = indexed(&[
        "src/a/one.rs",
        "src/a/two.rs",
        "src/a/deep/three.rs",
        "src/b/four.rs",
    ]);
    fixture
        .index
        .apply(&fixture.root, &[deleted("src/a", true)]);
    assert_eq!(fixture.index.len(), 1);
    assert_eq!(
        paths(&fixture.index.search("four.rs", 5)),
        ["src/b/four.rs"]
    );
    for gone in ["one.rs", "two.rs", "three.rs"] {
        assert!(fixture.index.search(gone, 5).is_empty(), "{gone} is gone");
    }
}

#[test]
fn created_folder_adds_its_subtree() {
    let mut fixture = indexed(&["src/main.rs"]);
    write(fixture.dir.path(), "src/new/one.rs", "");
    write(fixture.dir.path(), "src/new/deep/two.rs", "");
    fixture
        .index
        .apply(&fixture.root, &[created("src/new", true)]);
    assert_eq!(fixture.index.len(), 3);
    assert_eq!(
        paths(&fixture.index.search("one.rs", 5)),
        ["src/new/one.rs"]
    );
    assert_eq!(
        paths(&fixture.index.search("two.rs", 5)),
        ["src/new/deep/two.rs"]
    );
}

#[test]
fn apply_never_adds_paths_inside_dot_git() {
    let mut fixture = indexed(&["src/main.rs"]);
    write(fixture.dir.path(), ".git/config", "");
    write(fixture.dir.path(), ".git/hooks/pre-commit", "");
    fixture.index.apply(
        &fixture.root,
        &[created(".git", true), created(".git/config", false)],
    );
    assert_eq!(fixture.index.len(), 1);
    assert!(fixture.index.search("config", 5).is_empty());
    assert!(fixture.index.search("precommit", 5).is_empty());
}

#[test]
fn created_folder_respects_gitignore() {
    let mut fixture = indexed(&["src/main.rs", ".gitignore"]);
    write(fixture.dir.path(), ".gitignore", "build\n");
    write(fixture.dir.path(), "src/build/out.rs", "");
    write(fixture.dir.path(), "src/ok.rs", "");
    fixture.index.apply(&fixture.root, &[created("src", true)]);
    assert!(
        fixture.index.search("out.rs", 5).is_empty(),
        "an ignored file never enters through an update"
    );
    assert_eq!(paths(&fixture.index.search("ok.rs", 5)), ["src/ok.rs"]);
}
