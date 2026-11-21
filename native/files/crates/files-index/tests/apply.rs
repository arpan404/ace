// SPDX-License-Identifier: Apache-2.0

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use std::fs;

use files_index::{IndexChange, IndexOptions, PathIndex};
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

#[test]
fn a_deleted_folder_keeps_the_siblings_whose_names_start_with_its_own() {
    let siblings = [
        "src/a.rs",
        "src/ab/one.rs",
        "src/a-b/two.rs",
        "lib/src/a/three.rs",
    ];
    let doomed = ["src/a/one.rs", "src/a/deep/two.rs"];
    // A lone delete and a batch of many deletes take different routes through the index.
    for extra in [0, 200] {
        let filler: Vec<String> = (0..extra).map(|index| format!("tmp/f{index}.rs")).collect();
        let mut all: Vec<&str> = siblings.iter().chain(&doomed).copied().collect();
        all.extend(filler.iter().map(String::as_str));
        let mut fixture = indexed(&all);
        let mut changes = vec![deleted("src/a", true)];
        changes.extend(filler.iter().map(|path| deleted(path, false)));
        fixture.index.apply(&fixture.root, &changes);
        for kept in siblings {
            let name = kept.rsplit('/').next().unwrap_or(kept);
            assert!(
                paths(&fixture.index.search(name, 10)).contains(&kept),
                "{kept} stays when src/a goes ({extra} other deletes)"
            );
        }
        for gone in doomed {
            let name = gone.rsplit('/').next().unwrap_or(gone);
            assert!(
                !paths(&fixture.index.search(name, 10)).contains(&gone),
                "{gone} goes with src/a ({extra} other deletes)"
            );
        }
    }
}

/// A synthetic index of `folders` × 1,000 files, with each folder's own entry, as a walk records it.
fn large_index(folders: usize) -> PathIndex {
    let mut paths = Vec::with_capacity(folders * 1_001);
    for folder in 0..folders {
        paths.push(format!("pkg{folder}/"));
        for file in 0..1_000 {
            paths.push(format!("pkg{folder}/src/file{file}.rs"));
        }
    }
    PathIndex::from_paths(paths)
}

#[test]
fn a_deleted_file_leaves_a_large_index_without_a_pass_over_it() {
    // The watcher hands every batch to the index before the client hears it, so a deletion that
    // walks a million paths delays every delete and rename the Files panel sees.
    let (_dir, root) = checkout(&[]);
    let mut index = large_index(300);
    let before = index.len();
    let mut took = Vec::new();
    for round in 0..9 {
        let path = format!("pkg{round}/src/file{round}.rs");
        let started = std::time::Instant::now();
        index.apply(&root, &[deleted(&path, false)]);
        took.push(started.elapsed());
        assert!(
            !paths(&index.search(&path, 5)).contains(&path.as_str()),
            "{path} is gone"
        );
    }
    assert_eq!(index.len(), before - 9, "only the deleted files go");
    took.sort();
    let median = took[took.len() / 2];
    assert!(
        median < std::time::Duration::from_millis(20),
        "one deleted file should cost about one lookup, took {took:?}"
    );
}

#[test]
fn a_path_held_as_both_a_file_and_a_folder_drops_both_and_the_subtree() {
    // A file replaced by a folder of the same name inside one window reaches the index as a
    // change, not a deletion, so for a while it may hold both; a later deletion clears all of it.
    let (_dir, root) = checkout(&[]);
    let mut index =
        PathIndex::from_paths(["a", "a/", "a/inner.rs", "ab.rs", "b/a.rs"].map(str::to_owned));
    index.apply(&root, &[deleted("a", false)]);
    assert_eq!(index.len(), 2, "only ab.rs and b/a.rs stay");
    assert_eq!(paths(&index.search("ab.rs", 5)), ["ab.rs"]);
    assert_eq!(paths(&index.search("b/a.rs", 5)), ["b/a.rs"]);
    assert!(index.search("inner", 5).is_empty());
}

#[test]
fn a_folder_walked_again_leaves_an_index_no_larger_than_the_one_it_replaces() {
    // A burst rescans its folder by rebuilding the whole index beside the served one. The copy is
    // what stays, so slack in it is memory held for as long as the checkout is open.
    let files: Vec<String> = (0..4_000)
        .map(|file| format!("src/group_{:02}/module_{file:04}.rs", file % 40))
        .chain((0..1_000).map(|file| format!("burst/file_{file:04}.txt")))
        .collect();
    let names: Vec<&str> = files.iter().map(String::as_str).collect();
    let fixture = indexed(&names);
    let before = fixture.index.bytes_used();
    let rebuilt = fixture
        .index
        .rebuilt_folder(
            &fixture.root,
            "burst",
            &IndexOptions::default(),
            &std::sync::atomic::AtomicBool::new(false),
        )
        .expect("the folder is walked again");
    assert_eq!(rebuilt.len(), fixture.index.len());
    assert!(
        rebuilt.bytes_used() <= before + before / 10,
        "the rebuilt index uses {} bytes where the one it replaces used {before}",
        rebuilt.bytes_used()
    );
}

#[test]
fn a_folder_replaced_by_a_file_of_the_same_name_drops_the_folder_and_its_subtree() {
    // Inside one debounce window the watcher sees `pkg` change, not go: what is on disk now is a
    // file, so the folder entry and everything below it must go as the file comes in.
    let (dir, root) = checkout(&["other.rs"]);
    write(dir.path(), "pkg", "now a file");
    let mut index = PathIndex::from_paths(
        ["pkg/", "pkg/a.rs", "pkg/sub/", "pkg/sub/b.rs", "other.rs"].map(str::to_owned),
    );
    index.apply(&root, &[created("pkg", false)]);
    assert_eq!(index.len(), 2, "only pkg and other.rs stay");
    assert_eq!(paths(&index.search("pkg", 5)), ["pkg"]);
    assert!(index.search("b.rs", 5).is_empty());
    assert!(index.search("a.rs", 5).is_empty());
}

#[test]
fn a_file_replaced_by_a_folder_of_the_same_name_drops_the_file() {
    let (dir, root) = checkout(&["pkg/a.rs", "x.rs"]);
    let mut index = PathIndex::from_paths(["pkg", "x.rs"].map(str::to_owned));
    assert!(dir.path().join("pkg").is_dir());
    index.apply(&root, &[created("pkg", true)]);
    let hits = index.search("pkg", 10);
    let mut found = paths(&hits);
    found.sort_unstable();
    assert_eq!(found, ["pkg/", "pkg/a.rs"], "the file entry is gone");
    assert_eq!(index.len(), 3);
}
