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
        snapshot: false,
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
        snapshot: false,
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
fn refuses_a_page_larger_than_the_contract_allows() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let too_big = client.request(Op::List {
        root,
        dir: String::new(),
        limit: 5_001,
        cursor: None,
        hide: hide(),
        snapshot: false,
    });
    assert_eq!(client.error(too_big).code, "INVALID_ARGUMENT");

    let empty = client.request(Op::List {
        root,
        dir: String::new(),
        limit: 0,
        cursor: None,
        hide: hide(),
        snapshot: false,
    });
    assert_eq!(client.error(empty).code, "INVALID_ARGUMENT");
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

/// Quick open answers from an index built in the background, so a test waits for it.
fn await_index(client: &mut Client, root: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "the index never became ready"
        );
        let id = client.request(Op::IndexQuery {
            root,
            query: "a".to_owned(),
            limit: 5,
        });
        if let Reply::Index(index) = client.reply(id)
            && index.ready
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn transfer_temporaries_never_appear_in_listings_or_quick_open() {
    let checkout = checkout(&[("docs/a.md", "a\n")]);
    // The two names the daemon makes for itself: a deleted folder waiting in the trash, and an
    // upload staging its bytes beside the file it will become.
    common::write_file(
        checkout.path(),
        ".ace-upload-trash-1/kept.md",
        "deleted, not gone\n",
    );
    common::write_file(checkout.path(), "docs/.ace-upload-2", "uploading\n");

    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let names = |client: &mut Client, dir: &str| {
        let id = client.request(Op::List {
            root,
            dir: dir.to_owned(),
            limit: 100,
            cursor: None,
            hide: hide(),
            snapshot: false,
        });
        match client.reply(id) {
            Reply::Page(page) => page
                .entries
                .into_iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>(),
            other => panic!("list answered {other:?}"),
        }
    };

    assert_eq!(names(&mut client, ""), vec!["docs".to_owned()]);
    assert_eq!(names(&mut client, "docs"), vec!["a.md".to_owned()]);
    let trash = client.request(Op::List {
        root,
        dir: ".ace-upload-trash-1".to_owned(),
        limit: 100,
        cursor: None,
        hide: hide(),
        snapshot: false,
    });
    assert_eq!(
        client.error(trash).code,
        "INVALID_PATH",
        "a transfer temporary is never listed, even when it is named"
    );

    await_index(&mut client, root);
    for query in ["kept", "ace-upload", "upload"] {
        let id = client.request(Op::IndexQuery {
            root,
            query: query.to_owned(),
            limit: 20,
        });
        let Reply::Index(index) = client.reply(id) else {
            panic!("indexQuery answered");
        };
        assert!(
            index
                .hits
                .iter()
                .all(|hit| !hit.path.contains(".ace-upload-")),
            "quick open offered a transfer temporary for {query:?}: {:?}",
            index.hits
        );
    }
    let id = client.request(Op::IndexQuery {
        root,
        query: "a.md".to_owned(),
        limit: 5,
    });
    let Reply::Index(index) = client.reply(id) else {
        panic!("indexQuery answered");
    };
    assert_eq!(
        index.hits.first().map(|hit| hit.path.as_str()),
        Some("docs/a.md")
    );
}

#[test]
fn a_folder_deleted_after_the_build_leaves_no_paths_behind() {
    let checkout = checkout(&[("docs/old/kept.md", "deleted, not gone\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    await_index(&mut client, root);
    let id = client.request(Op::IndexQuery {
        root,
        query: "kept".to_owned(),
        limit: 10,
    });
    let Reply::Index(index) = client.reply(id) else {
        panic!("indexQuery answered");
    };
    assert!(
        index.hits.iter().any(|hit| hit.path == "docs/old/kept.md"),
        "the file is in the index before the delete: {:?}",
        index.hits
    );

    // A delete is a rename into the daemon's trash, which the watcher reports like any other
    // change: neither the folder's old paths nor its new name may reach a listing or quick open.
    let subscription = common::watch(&mut client, root);
    std::fs::rename(
        checkout.path().join("docs/old"),
        checkout.path().join(".ace-upload-trash-2"),
    )
    .expect("the delete's rename");
    common::await_reported(
        &mut client,
        checkout.path(),
        subscription,
        ".ace-upload-trash-2",
    );

    let id = client.request(Op::List {
        root,
        dir: String::new(),
        limit: 100,
        cursor: None,
        hide: hide(),
        snapshot: false,
    });
    let Reply::Page(page) = client.reply(id) else {
        panic!("list answered");
    };
    assert!(
        page.entries
            .iter()
            .all(|entry| !entry.name.starts_with(".ace-upload-")),
        "the trash name is not listed: {:?}",
        page.entries
    );

    for query in ["kept", "trash"] {
        let id = client.request(Op::IndexQuery {
            root,
            query: query.to_owned(),
            limit: 20,
        });
        let Reply::Index(index) = client.reply(id) else {
            panic!("indexQuery answered");
        };
        assert!(
            index
                .hits
                .iter()
                .all(|hit| !hit.path.contains(".ace-upload-") && hit.path != "docs/old/kept.md"),
            "quick open forgot the deleted folder for {query:?}: {:?}",
            index.hits
        );
    }
}
