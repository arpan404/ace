// SPDX-License-Identifier: Apache-2.0

//! Small helpers shared by the behaviour tests: building trees and paging to the end.
//!
//! Helpers are not `#[test]` functions, so clippy's test exemption for `unwrap` does not reach
//! them; a fixture that cannot be built should fail the test loudly anyway.

#![allow(dead_code)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::Path;

use files_list::{Entry, ListOptions, Lister, Page};
use files_safe::Root;

/// What the daemon passes as the default for `hide`.
pub const HIDE: [&str; 2] = [".git", ".DS_Store"];

pub fn lister(root: &Path) -> Lister {
    Lister::new(Root::open(root).unwrap())
}

pub fn options(limit: usize) -> ListOptions {
    ListOptions {
        limit,
        cursor: None,
        hide: HIDE.iter().map(|pattern| (*pattern).to_owned()).collect(),
    }
}

pub fn options_with_hide(limit: usize, hide: &[&str]) -> ListOptions {
    ListOptions {
        limit,
        cursor: None,
        hide: hide.iter().map(|pattern| (*pattern).to_owned()).collect(),
    }
}

pub fn folder(root: &Path, rel: &str) {
    fs::create_dir_all(root.join(rel)).unwrap();
}

pub fn file(root: &Path, rel: &str) {
    write(root, rel, "");
}

pub fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

/// Every entry of a folder, page by page, as the daemon would collect them.
pub fn all(lister: &Lister, dir: &str, options: &ListOptions) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        pages += 1;
        assert!(pages < 200, "listing {dir:?} did not reach its end");
        let page = lister
            .list(
                dir,
                &ListOptions {
                    cursor: cursor.clone(),
                    ..options.clone()
                },
            )
            .unwrap();
        entries.extend(page.entries);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return entries,
        }
    }
}

pub fn first_page(lister: &Lister, dir: &str, options: &ListOptions) -> Page {
    lister.list(dir, options).unwrap()
}

pub fn names(entries: &[Entry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.path.as_str()).collect()
}

pub fn entry<'a>(entries: &'a [Entry], path: &str) -> &'a Entry {
    entries
        .iter()
        .find(|entry| entry.path == path)
        .unwrap_or_else(|| panic!("no entry {path:?} in {:?}", names(entries)))
}

#[cfg(unix)]
pub fn symlink(root: &Path, rel: &str, target: &str) {
    std::os::unix::fs::symlink(target, root.join(rel)).unwrap();
}
