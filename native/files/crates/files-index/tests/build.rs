// SPDX-License-Identifier: Apache-2.0

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use std::sync::atomic::{AtomicBool, Ordering};

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
fn ignore_files_are_not_git_rules() {
    let (dir, root) = checkout(&["src/gen.rs", ".ignore"]);
    write(dir.path(), ".ignore", "gen.rs\n");
    let index = build_index(&root, &IndexOptions::default());
    assert_eq!(
        paths(&index.search("gen.rs", 5)),
        ["src/gen.rs"],
        "a .ignore file is not git's and must not hide anything"
    );
}

#[test]
fn a_root_outside_a_repository_ignores_only_its_own_gitignore() {
    let dir = tempfile::tempdir().expect("a temp dir");
    write(dir.path(), ".gitignore", "*.log\n");
    write(dir.path(), "sub/a.log", "");
    let root = files_safe::Root::open(&dir.path().join("sub")).expect("a checkout root");
    let index = build_index(&root, &IndexOptions::default());
    assert_eq!(
        paths(&index.search("a.log", 5)),
        ["a.log"],
        "parent folders outside a repository are not git's rules"
    );
}

#[test]
fn parent_gitignore_inside_the_repo_applies() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(repo.join(".git")).expect("git store");
    write(dir.path(), ".gitignore", "*.md\n");
    write(&repo, ".gitignore", "*.log\n");
    write(&repo, ".git/info/exclude", "scratch.txt\n");
    write(&repo, "sub/a.log", "");
    write(&repo, "sub/keep.rs", "");
    write(&repo, "sub/readme.md", "");
    write(&repo, "sub/scratch.txt", "");

    let root = files_safe::Root::open(&repo.join("sub")).expect("a checkout root");
    let index = build_index(&root, &IndexOptions::default());
    assert!(
        index.search("a.log", 5).is_empty(),
        "the repository's own .gitignore applies to a root below it"
    );
    assert!(
        index.search("scratch", 5).is_empty(),
        "the repository's .git/info/exclude applies too"
    );
    assert_eq!(paths(&index.search("keep.rs", 5)), ["keep.rs"]);
    assert_eq!(
        paths(&index.search("readme.md", 5)),
        ["readme.md"],
        "a .gitignore above the repository top does not apply"
    );
}

#[test]
fn skips_dot_git() {
    let (_dir, root) = checkout(&[".git/config", "src/.git/HEAD", "src/main.rs"]);
    let index = build_index(&root, &IndexOptions::default());
    assert_eq!(index.len(), 1);
    assert!(index.search("config", 5).is_empty());
    assert!(index.search("head", 5).is_empty());
    assert_eq!(paths(&index.search("mainrs", 5)), ["src/main.rs"]);
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

#[cfg(unix)]
#[test]
fn indexes_symlinks_to_files_inside_the_root() {
    let outside = tempfile::tempdir().expect("a temp dir");
    write(outside.path(), "secret.rs", "");
    let (dir, root) = checkout(&["real/file.rs"]);
    std::os::unix::fs::symlink("real/file.rs", dir.path().join("link.rs")).expect("file link");
    std::os::unix::fs::symlink("real", dir.path().join("dirlink")).expect("folder link");
    std::os::unix::fs::symlink(
        outside.path().join("secret.rs"),
        dir.path().join("escape.rs"),
    )
    .expect("outside link");

    let index = build_index(&root, &IndexOptions::default());
    assert_eq!(index.len(), 2, "the folder link is not followed");
    assert_eq!(paths(&index.search("link.rs", 5)), ["link.rs"]);
    assert!(index.search("escape.rs", 5).is_empty());
    assert!(index.search("secret.rs", 5).is_empty());
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
    let cancel = AtomicBool::new(false);
    let result =
        PathIndex::build_with_progress(&root, &IndexOptions::default(), &cancel, &|seen| {
            if seen == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
    let error = result.expect_err("a cancelled build produces no index");
    assert_eq!(error.code(), "ABORTED");
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
