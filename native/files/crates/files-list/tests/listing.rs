// SPDX-License-Identifier: Apache-2.0

//! What one folder listing returns, and in what order.

mod support;

use std::fs::File;

use files_list::{Kind, ListOptions};
use tempfile::TempDir;

use support::{first_page, folder, lister, names, options, options_with_hide};

#[test]
fn lists_one_level_only() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    support::write(root, "alpha.txt", "a");
    support::write(root, "beta.txt", "b");
    support::write(root, "folder/nested.txt", "n");
    support::write(root, "gamma/deep/leaf.txt", "l");

    let listing = first_page(&lister(root), "", &options(100));

    assert_eq!(
        names(&listing.entries),
        ["folder", "gamma", "alpha.txt", "beta.txt"]
    );
    assert_eq!(listing.total, 4);
    assert_eq!(listing.next_cursor, None);
}

#[test]
fn lists_folders_before_files_in_natural_order() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for name in ["file10.txt", "file2.txt", "File1.txt", "ab.txt", "a b.txt"] {
        support::write(root, name, "x");
    }
    for name in ["zdir", "adir10", "adir2"] {
        folder(root, name);
    }

    let listing = first_page(&lister(root), "", &options(100));

    assert_eq!(
        names(&listing.entries),
        [
            "adir2",
            "adir10",
            "zdir",
            "a b.txt",
            "ab.txt",
            "File1.txt",
            "file2.txt",
            "file10.txt",
        ]
    );
}

#[test]
fn lists_an_empty_folder() {
    let home = TempDir::new().unwrap();

    let listing = first_page(&lister(home.path()), "", &options(10));

    assert!(listing.entries.is_empty());
    assert_eq!(listing.total, 0);
    assert_eq!(listing.next_cursor, None);
}

#[test]
fn hide_patterns_never_list() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, ".git");
    folder(root, "build");
    support::write(root, ".DS_Store", "x");
    support::write(root, "notes.txt", "x");
    support::write(root, "build/artifact.bin", "x");

    let listing = first_page(
        &lister(root),
        "",
        &options_with_hide(100, &[".git", ".DS_Store", "build"]),
    );

    assert_eq!(names(&listing.entries), ["notes.txt"]);
    assert_eq!(listing.total, 1);
}

#[test]
fn rejects_a_limit_outside_the_allowed_range() {
    let home = TempDir::new().unwrap();
    let lister = lister(home.path());

    for limit in [0, 5001, usize::MAX] {
        let error = lister.list("", &options(limit)).unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT", "limit {limit}");
    }
}

#[test]
fn rejects_a_hide_pattern_that_is_not_a_glob() {
    let home = TempDir::new().unwrap();
    let lister = lister(home.path());

    let error = lister
        .list("", &options_with_hide(10, &["[z-a]"]))
        .unwrap_err();

    assert_eq!(error.code(), "INVALID_ARGUMENT");
}

#[test]
fn rejects_a_malformed_cursor() {
    let home = TempDir::new().unwrap();
    let lister = lister(home.path());

    for cursor in ["", "nonsense", "v1.zz.1.0", "v1.1.1.0.9", "v2.1.1.0"] {
        let error = lister
            .list(
                "",
                &ListOptions {
                    cursor: Some(cursor.to_owned()),
                    ..options(10)
                },
            )
            .unwrap_err();
        assert_eq!(error.code(), "INVALID_CURSOR", "cursor {cursor:?}");
    }
}

#[test]
fn lists_the_same_folder_from_several_threads() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for index in 0..20 {
        support::write(root, &format!("f{index}.txt"), "x");
    }
    let lister = lister(root);
    let listing = |lister: &files_list::Lister| lister.list("", &options(100)).unwrap();

    let pages = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4).map(|_| scope.spawn(|| listing(&lister))).collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });

    assert_eq!(pages[0].total, 20);
    assert!(pages.windows(2).all(|pair| pair[0] == pair[1]));
}

#[test]
fn does_not_list_entries_the_api_could_not_address() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    support::write(root, "plain.txt", "x");
    File::create(root.join("back\\slash.txt")).unwrap();

    let listing = first_page(&lister(root), "", &options(10));

    assert_eq!(names(&listing.entries), ["plain.txt"]);
    assert_eq!(listing.total, 1);
}

#[cfg(unix)]
#[test]
fn lists_a_symlinked_folder_under_its_logical_path() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    support::write(root, "real/inner.txt", "x");
    support::symlink(root, "alias", "real");

    let listing = first_page(&lister(root), "alias", &options(10));

    assert_eq!(names(&listing.entries), ["alias/inner.txt"]);
    assert_eq!(listing.entries[0].kind, Kind::File);
}

#[test]
fn folders_report_no_size() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, "sub");

    let listing = first_page(&lister(root), "", &options(10));

    assert_eq!(support::entry(&listing.entries, "sub").size, 0);
}

#[test]
fn lists_sizes_and_times_inside_a_subfolder() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    support::write(root, "sub/alpha.txt", "12345");
    support::write(root, "sub/deeper/beta.txt", "12");

    let lister = lister(root);
    let inner = first_page(&lister, "sub", &options(100));
    let alpha = support::entry(&inner.entries, "sub/alpha.txt");
    assert_eq!(alpha.size, 5);
    assert!(alpha.mtime_ms > 0, "a subfolder entry keeps its time");

    let deeper = first_page(&lister, "sub/deeper", &options(100));
    let beta = support::entry(&deeper.entries, "sub/deeper/beta.txt");
    assert_eq!(beta.size, 2);
    assert!(beta.mtime_ms > 0);
}

#[cfg(unix)]
#[test]
fn hide_patterns_treat_a_symlinked_folder_as_a_folder() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, "real");
    support::symlink(root, "alias", "real");
    support::write(root, "notes.txt", "x");

    let listing = first_page(&lister(root), "", &options_with_hide(100, &["alias/"]));

    assert_eq!(names(&listing.entries), ["real", "notes.txt"]);
}
