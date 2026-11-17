// SPDX-License-Identifier: Apache-2.0

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use std::sync::atomic::AtomicBool;

use files_index::{IndexOptions, PathIndex};
use support::{build_index, checkout, paths, write};

#[test]
fn respects_gitignore() {
    let (dir, root) = checkout(&["src/main.rs", "target/debug/out.rs", ".gitignore"]);
    write(dir.path(), ".gitignore", "target\n");
    let ignored = build_index(&root, &IndexOptions::default());
    assert!(ignored.search("out.rs", 10).is_empty());
    assert_eq!(paths(&ignored.search("main.rs", 10)), ["src/main.rs"]);

    let all = IndexOptions {
        include_ignored: true,
        ..IndexOptions::default()
    };
    let all = build_index(&root, &all);
    assert_eq!(paths(&all.search("out.rs", 10)), ["target/debug/out.rs"]);
}

#[test]
fn includes_dotfiles_but_never_the_git_directory() {
    let (_dir, root) = checkout(&[".env", ".github/workflows/ci.yml", ".git/config"]);
    let index = build_index(&root, &IndexOptions::default());
    assert_eq!(
        paths(&index.search("env", 10)),
        [".env"],
        "a dotfile at the root is indexed"
    );
    assert_eq!(
        paths(&index.search("ci.yml", 10)),
        [".github/workflows/ci.yml"]
    );
    assert!(
        index.search("config", 10).is_empty(),
        "the git store is skipped"
    );
}

#[test]
fn stops_at_max_files_and_reports_truncated() {
    let files: Vec<String> = (0..40)
        .map(|number| format!("src/file{number}.rs"))
        .collect();
    let files: Vec<&str> = files.iter().map(String::as_str).collect();
    let (_dir, root) = checkout(&files);
    let capped = IndexOptions {
        max_files: 12,
        ..IndexOptions::default()
    };
    let index = build_index(&root, &capped);
    assert_eq!(index.len(), 12);
    assert!(index.truncated());
    assert!(!index.is_empty());

    let uncapped = build_index(&root, &IndexOptions::default());
    assert_eq!(uncapped.len(), 40);
    assert!(!uncapped.truncated());
}

#[test]
fn cancel_stops_build() {
    let files: Vec<String> = (0..40)
        .map(|number| format!("src/file{number}.rs"))
        .collect();
    let files: Vec<&str> = files.iter().map(String::as_str).collect();
    let (_dir, root) = checkout(&files);
    let index = PathIndex::build(&root, &IndexOptions::default(), &AtomicBool::new(true))
        .expect("a cancelled build still returns");
    assert_eq!(index.len(), 0);
    assert!(!index.truncated());
}

#[test]
fn rejects_a_max_files_cap_of_zero() {
    let (_dir, root) = checkout(&["src/main.rs"]);
    let options = IndexOptions {
        max_files: 0,
        ..IndexOptions::default()
    };
    let error = PathIndex::build(&root, &options, &AtomicBool::new(false))
        .expect_err("a zero cap is not a valid index");
    assert_eq!(error.code(), "INVALID_ARGUMENT");
}
