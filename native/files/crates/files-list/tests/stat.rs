// SPDX-License-Identifier: Apache-2.0

//! Single-entry stats, including what symlinks report.

mod support;

use files_list::{Kind, Lister};
use tempfile::TempDir;

use support::{folder, lister, options, write};

#[test]
fn stat_reports_a_file() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "src/main.rs", "fn main() {}\n");

    let entry = lister(root).stat("src/main.rs").unwrap();

    assert_eq!(entry.path, "src/main.rs");
    assert_eq!(entry.name, "main.rs");
    assert_eq!(entry.kind, Kind::File);
    assert_eq!(entry.size, 13);
    assert!(entry.mtime_ms > 0);
    assert!(!entry.ignored);
}

#[test]
fn stat_reports_a_folder_without_a_size() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, "src");

    let entry = lister(root).stat("src").unwrap();

    assert_eq!(entry.kind, Kind::Directory);
    assert_eq!(entry.size, 0);
}

#[test]
fn stat_marks_an_ignored_file() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, ".gitignore", "*.ignored-by-test\n");
    write(root, "artifact.ignored-by-test", "x");
    write(root, "kept.txt", "x");

    let lister = lister(root);

    assert!(lister.stat("artifact.ignored-by-test").unwrap().ignored);
    assert!(!lister.stat("kept.txt").unwrap().ignored);
}

#[test]
fn stat_of_a_missing_path_is_not_found() {
    let home = TempDir::new().unwrap();

    let error = lister(home.path()).stat("missing.txt").unwrap_err();

    assert_eq!(error.code(), "NOT_FOUND");
}

#[test]
fn stat_of_a_path_under_a_file_is_not_a_directory() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "alpha.txt", "x");

    let error = lister(root).stat("alpha.txt/inner.txt").unwrap_err();

    assert_eq!(error.code(), "NOT_DIRECTORY");
}

#[test]
fn stat_refuses_paths_that_break_the_rules() {
    let home = TempDir::new().unwrap();
    let lister = lister(home.path());

    for path in [
        "",
        "/etc/passwd",
        "../escape.txt",
        "a/../b",
        "trailing/",
        "nul\0byte",
    ] {
        let error = lister.stat(path).unwrap_err();
        assert_eq!(error.code(), "INVALID_PATH", "path {path:?}");
    }
}

#[test]
fn listing_a_file_is_not_directory() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "alpha.txt", "x");

    let lister = lister(root);
    assert_eq!(
        lister.list("alpha.txt", &options(10)).unwrap_err().code(),
        "NOT_DIRECTORY"
    );
    assert_eq!(
        lister.list("missing", &options(10)).unwrap_err().code(),
        "NOT_FOUND"
    );
}

#[cfg(unix)]
#[test]
fn symlink_reports_target_kind() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "alpha.txt", "x");
    write(root, "sub/inner.txt", "x");
    let elsewhere = TempDir::new().unwrap();
    write(elsewhere.path(), "outside.txt", "x");
    support::symlink(root, "link-file", "alpha.txt");
    support::symlink(root, "link-dir", "sub");
    support::symlink(
        root,
        "link-outside",
        &elsewhere.path().join("outside.txt").display().to_string(),
    );
    support::symlink(root, "dangling", "missing.txt");

    let lister = lister(root);
    let page = support::first_page(&lister, "", &options(100));

    assert_eq!(
        support::entry(&page.entries, "link-file").kind,
        Kind::Symlink {
            target: Some(Box::new(Kind::File))
        }
    );
    assert_eq!(
        support::entry(&page.entries, "link-dir").kind,
        Kind::Symlink {
            target: Some(Box::new(Kind::Directory))
        }
    );
    assert_eq!(
        support::entry(&page.entries, "link-outside").kind,
        Kind::Symlink { target: None }
    );
    assert_eq!(
        support::entry(&page.entries, "dangling").kind,
        Kind::Symlink { target: None }
    );
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_folder_sorts_with_folders() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "alpha.txt", "x");
    folder(root, "zdir");
    support::symlink(root, "adir", "zdir");

    let page = support::first_page(&lister(root), "", &options(100));

    assert_eq!(support::names(&page.entries), ["adir", "zdir", "alpha.txt"]);
}

/// A lister is handed between the daemon's threads, so it has to be usable from more than one.
#[test]
fn a_lister_can_be_moved_to_another_thread() {
    let home = TempDir::new().unwrap();
    write(home.path(), "alpha.txt", "x");
    let lister: Lister = lister(home.path());

    let total = std::thread::spawn(move || lister.list("", &options(1)).unwrap().total)
        .join()
        .unwrap();

    assert_eq!(total, 1);
}

#[cfg(unix)]
#[test]
fn a_symlink_to_outside_lists_without_a_target_kind() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    let elsewhere = TempDir::new().unwrap();
    write(elsewhere.path(), "outside.txt", "x");
    support::symlink(
        root,
        "escape",
        &elsewhere.path().join("outside.txt").display().to_string(),
    );

    let lister = lister(root);
    let page = support::first_page(&lister, "", &options(10));
    let listed = support::entry(&page.entries, "escape");
    assert_eq!(listed.kind, Kind::Symlink { target: None });
    assert_eq!(
        lister.stat("escape").unwrap().kind,
        Kind::Symlink { target: None }
    );
}

#[cfg(unix)]
#[test]
fn a_root_that_was_moved_and_replaced_reports_path_changed() {
    let home = TempDir::new().unwrap();
    let root = home.path().join("checkout");
    folder(&root, "src");
    write(&root, "src/main.rs", "x");
    let lister = lister(&root);

    std::fs::rename(&root, home.path().join("moved")).unwrap();
    folder(home.path(), "elsewhere");
    support::symlink(
        home.path(),
        "checkout",
        &home.path().join("elsewhere").display().to_string(),
    );

    assert_eq!(
        lister.list("", &options(10)).unwrap_err().code(),
        "PATH_CHANGED"
    );
    assert_eq!(
        lister.stat("src/main.rs").unwrap_err().code(),
        "PATH_CHANGED"
    );
}
