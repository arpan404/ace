// SPDX-License-Identifier: Apache-2.0

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use std::fs;

use files_index::{IndexChange, IndexOptions};
use support::{build_index, checkout, indexed, paths, write};

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
    assert_eq!(fixture.index.len(), 4);

    fixture
        .index
        .apply(&fixture.root, &[created("src/new.rs", false)]);
    assert_eq!(
        fixture.index.len(),
        4,
        "a repeated save is not a second file"
    );

    fs::remove_file(fixture.dir.path().join("src/old.rs")).expect("delete old.rs");
    fixture
        .index
        .apply(&fixture.root, &[deleted("src/old.rs", false)]);
    assert!(fixture.index.search("old.rs", 5).is_empty());
    assert_eq!(fixture.index.len(), 3);
}

#[test]
fn prepare_runs_before_the_index_changes() {
    let mut fixture = indexed(&["src/main.rs"]);
    write(fixture.dir.path(), "src/new/one.rs", "");
    let prepared = fixture.index.prepare(
        &fixture.root,
        &[created("src/new", true), deleted("src/main.rs", false)],
    );
    assert_eq!(fixture.index.len(), 2, "prepare leaves the index alone");
    assert_eq!(paths(&fixture.index.search("main.rs", 5)), ["src/main.rs"]);

    fixture.index.commit(prepared);
    assert_eq!(fixture.index.len(), 3);
    assert!(fixture.index.search("main.rs", 5).is_empty());
    assert_eq!(
        paths(&fixture.index.search("one.rs", 5)),
        ["src/new/one.rs"]
    );
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
    assert_eq!(fixture.index.len(), 3);
    assert_eq!(
        paths(&fixture.index.search("four.rs", 5)),
        ["src/b/four.rs"]
    );
    for gone in ["one.rs", "two.rs", "three.rs"] {
        assert!(fixture.index.search(gone, 5).is_empty(), "{gone} is gone");
    }
}

#[test]
fn deleted_folder_reported_as_a_file_drops_its_subtree() {
    let mut fixture = indexed(&["src/a/one.rs", "src/a/two.rs", "src/b/three.rs"]);
    fixture
        .index
        .apply(&fixture.root, &[deleted("src/a", false)]);
    assert_eq!(fixture.index.len(), 3);
    assert!(fixture.index.search("one.rs", 5).is_empty());
    assert!(fixture.index.search("two.rs", 5).is_empty());
    assert_eq!(
        paths(&fixture.index.search("three.rs", 5)),
        ["src/b/three.rs"]
    );
}

#[test]
fn created_folder_adds_its_subtree() {
    let mut fixture = indexed(&["src/main.rs"]);
    write(fixture.dir.path(), "src/new/one.rs", "");
    write(fixture.dir.path(), "src/new/deep/two.rs", "");
    fixture
        .index
        .apply(&fixture.root, &[created("src/new", true)]);
    assert_eq!(fixture.index.len(), 6);
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

#[test]
fn apply_skips_a_gitignored_folder() {
    let mut fixture = indexed(&["src/main.rs", ".gitignore"]);
    write(fixture.dir.path(), ".gitignore", "build\n");
    write(fixture.dir.path(), "src/build/out.rs", "");
    fixture
        .index
        .apply(&fixture.root, &[created("src/build", true)]);
    assert!(fixture.index.search("out.rs", 5).is_empty());
    assert_eq!(fixture.index.len(), 3);
}

#[test]
fn apply_skips_a_gitignored_file() {
    let mut fixture = indexed(&["src/main.rs", ".gitignore"]);
    write(fixture.dir.path(), ".gitignore", "target\n");
    write(fixture.dir.path(), "target/debug/foo.d", "");
    fixture
        .index
        .apply(&fixture.root, &[created("target/debug/foo.d", false)]);
    assert!(fixture.index.search("foo.d", 5).is_empty());
    assert_eq!(fixture.index.len(), 3);
}

#[test]
fn apply_skips_a_hidden_folder() {
    let (dir, root) = checkout(&["src/main.rs"]);
    let options = IndexOptions {
        hide: vec!["node_modules".to_owned()],
        ..IndexOptions::default()
    };
    let mut index = build_index(&root, &options);
    write(dir.path(), "node_modules/x/y.js", "");
    index.apply(
        &root,
        &[
            created("node_modules/x/y.js", false),
            created("node_modules", true),
        ],
    );
    assert!(index.search("y.js", 5).is_empty());
    assert_eq!(index.len(), 2);
}

#[test]
fn deletions_clear_truncation() {
    let files: Vec<String> = (0..40)
        .map(|number| format!("src/file{number}.rs"))
        .collect();
    let files: Vec<&str> = files.iter().map(String::as_str).collect();
    let (_dir, root) = checkout(&files);
    let options = IndexOptions {
        max_files: 12,
        ..IndexOptions::default()
    };
    let mut index = build_index(&root, &options);
    assert!(index.truncated());

    let deletes: Vec<IndexChange> = (0..40)
        .map(|number| deleted(&format!("src/file{number}.rs"), false))
        .collect();
    index.apply(&root, &deletes);
    // The folder itself stays: its files are gone, the path is not.
    assert_eq!(index.len(), 1);
    assert!(!index.truncated(), "the index is under its cap again");
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
    assert_eq!(fixture.index.len(), 2);
    assert!(fixture.index.search("config", 5).is_empty());
    assert!(fixture.index.search("precommit", 5).is_empty());
}

#[test]
fn a_batch_of_twenty_thousand_creates_is_indexed_fully() {
    // A watcher batch carries the files it saw, so the paths need not exist for the index to hold
    // them; the folders do, because a created folder is walked. This is the Linux burst: twenty
    // thousand creates under one folder tree, delivered as ordinary change batches.
    let (dir, root) = checkout(&["src/main.rs", ".gitignore"]);
    write(dir.path(), ".gitignore", "target/\n*.log\n");
    for set in 0..20 {
        fs::create_dir_all(dir.path().join(format!("burst/set_{set:02}"))).expect("a burst folder");
    }
    let mut index = build_index(&root, &IndexOptions::default());
    let indexed_before = index.len();

    let mut changes: Vec<IndexChange> = Vec::with_capacity(20_001);
    for set in 0..20 {
        for file in 0..1_000 {
            changes.push(created(
                &format!("burst/set_{set:02}/burst_{file:05}.txt"),
                false,
            ));
        }
    }
    // One path the batch must still refuse: its folder is gitignored.
    changes.push(created("target/debug/ignored.txt", false));

    for batch in changes.chunks(5_000) {
        index.apply(&root, batch);
    }

    assert_eq!(
        index.len(),
        indexed_before + 20_000,
        "every created file is indexed once, and the ignored one is not"
    );
    for file in [0, 500, 9_999, 19_999] {
        let set = file / 1_000;
        let path = format!("burst/set_{set:02}/burst_{:05}.txt", file % 1_000);
        assert!(
            paths(&index.search(&path, 5)).contains(&path.as_str()),
            "{path} must be findable"
        );
    }
    assert!(
        index.search("ignored", 5).is_empty(),
        "a gitignored path never enters through a batch"
    );
}
