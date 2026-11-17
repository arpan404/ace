// SPDX-License-Identifier: Apache-2.0

//! Paging: a folder bigger than one page is read without gaps or repeats, and a cursor outlives
//! the folder it came from only until the folder changes.

mod support;

use std::collections::HashSet;
use std::fs::File;

use files_list::ListOptions;
use tempfile::TempDir;

use support::{first_page, lister, options};

const FILES: usize = 12_000;
const PAGE: usize = 5_000;

#[test]
fn pages_through_a_folder_of_12000_files_without_gaps_or_repeats() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for index in 0..FILES {
        File::create(root.join(format!("f{index:05}.txt"))).unwrap();
    }

    let lister = lister(root);
    let mut seen: Vec<String> = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        pages += 1;
        assert!(pages <= 3, "expected three pages, got at least {pages}");
        let page = lister
            .list(
                "",
                &ListOptions {
                    limit: PAGE,
                    cursor,
                    hide: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(page.total, FILES);
        assert!(page.entries.len() <= PAGE);
        seen.extend(page.entries.into_iter().map(|entry| entry.path));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    assert_eq!(pages, 3);
    assert_eq!(seen.len(), FILES);
    assert_eq!(seen.iter().collect::<HashSet<_>>().len(), FILES);
    let expected: Vec<String> = (0..FILES).map(|index| format!("f{index:05}.txt")).collect();
    assert_eq!(seen, expected);
}

#[test]
fn pages_hold_the_next_slice_of_the_folder() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for index in 0..5 {
        support::write(root, &format!("f{index}.txt"), "x");
    }
    let lister = lister(root);

    let first = first_page(&lister, "", &options(2));
    assert_eq!(first.total, 5);
    assert_eq!(support::names(&first.entries), ["f0.txt", "f1.txt"]);
    let cursor = first.next_cursor.clone().unwrap();

    let second = lister
        .list(
            "",
            &ListOptions {
                limit: 2,
                cursor: Some(cursor),
                ..options(2)
            },
        )
        .unwrap();
    assert_eq!(support::names(&second.entries), ["f2.txt", "f3.txt"]);
    assert_eq!(second.total, 5);

    let last = lister
        .list(
            "",
            &ListOptions {
                limit: 2,
                cursor: second.next_cursor,
                ..options(2)
            },
        )
        .unwrap();
    assert_eq!(support::names(&last.entries), ["f4.txt"]);
    assert_eq!(last.next_cursor, None);
    assert_eq!(last.total, 5);
}

#[test]
fn cursor_from_a_changed_folder_is_rejected() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for name in ["a.txt", "b.txt", "c.txt"] {
        support::write(root, name, "x");
    }

    let lister = lister(root);
    let first = first_page(&lister, "", &options(2));
    let cursor = first.next_cursor.unwrap();

    support::write(root, "d.txt", "x");

    let error = lister
        .list(
            "",
            &ListOptions {
                cursor: Some(cursor),
                ..options(2)
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), "INVALID_CURSOR");

    let fresh = first_page(&lister, "", &options(10));
    assert_eq!(fresh.total, 4);
}

#[test]
fn a_cursor_from_the_root_is_not_honoured_by_a_child_folder() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for index in 0..4 {
        support::write(root, &format!("sub/f{index}.txt"), "x");
    }
    support::folder(root, "other");

    let lister = lister(root);
    let outer = first_page(&lister, "", &options(1));
    let cursor = outer.next_cursor.unwrap();

    let error = lister
        .list(
            "sub",
            &ListOptions {
                cursor: Some(cursor),
                ..options(1)
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), "INVALID_CURSOR");
}

#[test]
fn a_cursor_is_not_trusted_while_the_folder_is_racy() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    for index in 0..4 {
        support::write(root, &format!("f{index}.txt"), "x");
    }

    let clock = std::sync::Arc::new(support::FakeClock::new(std::time::SystemTime::now()));
    let lister = support::lister_with(root, clock.clone());
    let first = first_page(&lister, "", &options(2));
    let cursor = first.next_cursor.unwrap();

    let refused = lister
        .list(
            "",
            &ListOptions {
                cursor: Some(cursor.clone()),
                ..options(2)
            },
        )
        .unwrap_err();
    assert_eq!(refused.code(), "INVALID_CURSOR");

    clock.set(std::time::SystemTime::now() + std::time::Duration::from_secs(3));

    let second = lister
        .list(
            "",
            &ListOptions {
                cursor: Some(cursor),
                ..options(2)
            },
        )
        .unwrap();
    assert_eq!(support::names(&second.entries), ["f2.txt", "f3.txt"]);
}
