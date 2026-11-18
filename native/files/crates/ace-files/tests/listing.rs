// SPDX-License-Identifier: Apache-2.0

//! `openRoot`, `list` and `stat` against a real temp checkout.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::Duration;

use common::{Client, checkout};
use files_wire::{Kind, Op, Reply};

fn hide() -> Vec<String> {
    vec![".git".to_owned(), ".DS_Store".to_owned()]
}

/// Folders first, then files, both in natural order, two entries at a time.
#[test]
fn pages_through_a_folder_in_vs_code_order() {
    let checkout = checkout(&[
        ("b.txt", "bbb"),
        ("a.txt", "aaaa"),
        ("m/inner.txt", ""),
        ("z/inner.txt", ""),
    ]);
    // A folder that changed in the last two seconds has cursors the lister refuses on purpose:
    // its stamp cannot prove the listing held still. Wait for it to settle.
    std::thread::sleep(Duration::from_millis(2_100));

    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let first = client.request(Op::List {
        root,
        dir: String::new(),
        limit: 2,
        cursor: None,
        hide: hide(),
    });
    let page = match client.reply(first) {
        Reply::Page(page) => page,
        other => panic!("list answered {other:?}"),
    };
    assert_eq!(
        page.entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["m", "z"],
        "folders come before files"
    );
    assert!(
        page.entries
            .iter()
            .all(|entry| entry.kind == Kind::Directory),
        "the first page holds only folders"
    );
    assert_eq!(page.total, 4);
    let cursor = page.next_cursor.expect("another page follows");

    let second = client.request(Op::List {
        root,
        dir: String::new(),
        limit: 2,
        cursor: Some(cursor),
        hide: hide(),
    });
    let page = match client.reply(second) {
        Reply::Page(page) => page,
        other => panic!("list answered {other:?}"),
    };
    assert_eq!(
        page.entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["a.txt", "b.txt"],
        "files follow folders, in natural order"
    );
    assert_eq!(page.total, 4);
    assert!(page.next_cursor.is_none(), "the folder is fully listed");
}

#[test]
fn reports_one_path() {
    let checkout = checkout(&[("src/main.rs", "fn main() {}\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Stat {
        root,
        path: "src/main.rs".to_owned(),
    });
    let entry = match client.reply(id) {
        Reply::Entry(entry) => entry,
        other => panic!("stat answered {other:?}"),
    };
    assert_eq!(entry.name, "main.rs");
    assert_eq!(entry.path, "src/main.rs");
    assert_eq!(entry.kind, Kind::File);
    assert_eq!(entry.size, 13);
    assert!(!entry.ignored);

    let missing = client.request(Op::Stat {
        root,
        path: "src/missing.rs".to_owned(),
    });
    assert_eq!(client.error(missing).code, "NOT_FOUND");
}

#[test]
fn closing_a_root_closes_its_requests() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let closed = client.request(Op::CloseRoot { root });
    assert_eq!(client.reply(closed), Reply::Done);

    let after = client.request(Op::Stat {
        root,
        path: "a.txt".to_owned(),
    });
    assert_eq!(client.error(after).code, "INVALID_ARGUMENT");
}
