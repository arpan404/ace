// SPDX-License-Identifier: Apache-2.0

//! `openRoot`, `list` and `stat` against a real temp checkout.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::Duration;
#[cfg(feature = "test-hooks")]
use std::time::Instant;

use common::{Client, checkout};
#[cfg(feature = "test-hooks")]
use files_wire::{ChangeKind, EventPayload};
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
fn a_pinned_traversal_pages_a_folder_renamed_between_pages() {
    let checkout = checkout(&[
        ("sub/a.txt", ""),
        ("sub/b.txt", ""),
        ("sub/c.txt", ""),
        ("sub/d.txt", ""),
    ]);
    // A traversal pins its listing, so the folder's stamp never refuses a cursor; a folder that
    // changed a moment ago is exactly the case that needs it.
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let first = client.request(Op::List {
        root,
        dir: "sub".to_owned(),
        limit: 2,
        cursor: None,
        hide: hide(),
        snapshot: true,
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
        ["a.txt", "b.txt"]
    );
    let cursor = page.next_cursor.expect("another page follows");

    // The folder moves before the next page is asked for. The traversal keeps the handle it
    // first read, so the remaining pages still describe the folder it pinned.
    std::fs::rename(checkout.path().join("sub"), checkout.path().join("moved"))
        .expect("the rename");

    let second = client.request(Op::List {
        root,
        dir: "sub".to_owned(),
        limit: 2,
        cursor: Some(cursor),
        hide: hide(),
        snapshot: true,
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
        ["c.txt", "d.txt"]
    );
    assert_eq!(page.total, 4);
    assert!(page.next_cursor.is_none());
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
    assert_eq!(client.reply(closed), Reply::done());

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

/// How the watcher told the subscriber about a change.
#[cfg(feature = "test-hooks")]
enum Told {
    /// A batch named the path.
    Batch,
    /// A rescan covered it, so the index walks again and serves its old copy until then.
    Rescan,
}

/// How long a rescan's walk may take to publish on a loaded machine.
#[cfg(feature = "test-hooks")]
const SETTLE_DEADLINE: Duration = Duration::from_secs(60);

/// Wait until the watch reports `path`: a batch naming it, or a rescan of a folder holding it.
/// Either is the watcher's contract; which one arrives depends on how late the OS watch is.
#[cfg(feature = "test-hooks")]
fn await_told(client: &mut Client, subscription: u64, path: &str) -> Told {
    let deadline = Instant::now() + SETTLE_DEADLINE;
    let mut seen = Vec::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "no batch named {path} and no rescan covered it within {SETTLE_DEADLINE:?}; saw {seen:?}"
        );
        match client.try_event(subscription, Duration::from_millis(500)) {
            Some(EventPayload::Changes { changes }) => {
                if changes
                    .iter()
                    .any(|change| change.path == path && change.kind != ChangeKind::Deleted)
                {
                    return Told::Batch;
                }
                seen.push(EventPayload::Changes { changes });
            }
            Some(EventPayload::Rescan { dir }) => match dir.as_deref() {
                None => return Told::Rescan,
                Some(dir) if path.starts_with(&format!("{dir}/")) => return Told::Rescan,
                Some(_) => seen.push(EventPayload::Rescan { dir }),
            },
            Some(other) => seen.push(other),
            None => {}
        }
    }
}

/// What a listing of the root and quick open still show of the deleted folder: its trash name
/// or its old file. Empty when neither is left.
#[cfg(feature = "test-hooks")]
fn deleted_folder_leftovers(client: &mut Client, root: u64) -> Vec<String> {
    let mut left = Vec::new();
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
    left.extend(
        page.entries
            .into_iter()
            .filter(|entry| entry.name.starts_with(".ace-upload-"))
            .map(|entry| format!("listed {}", entry.name)),
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
        left.extend(
            index
                .hits
                .into_iter()
                .filter(|hit| hit.path.contains(".ace-upload-") || hit.path == "docs/old/kept.md")
                .map(|hit| format!("quick open for {query:?} found {}", hit.path)),
        );
    }
    left
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_folder_deleted_after_the_build_leaves_no_paths_behind() {
    let checkout = checkout(&[("docs/old/kept.md", "deleted, not gone\n")]);
    let mut client = Client::launch(&[("ACE_FILES_INDEX_EVENTS", "1")], true);
    client.hello();
    let root = client.open_root(checkout.path());
    await_index(&mut client, root);
    client.await_index_published(1);
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
    let published = client.index_publishes();
    std::fs::rename(
        checkout.path().join("docs/old"),
        checkout.path().join(".ace-upload-trash-2"),
    )
    .expect("the delete's rename");
    match await_told(&mut client, subscription, ".ace-upload-trash-2") {
        // A batch is applied before it is reported, so every answer after it reflects it.
        Told::Batch => {
            let left = deleted_folder_leftovers(&mut client, root);
            assert!(
                left.is_empty(),
                "the deleted folder is still shown: {left:?}"
            );
        }
        // A rescan walks again while the old index keeps answering, by design. Once a walk
        // started after the move has published, the old paths must be gone. A walk already
        // running may publish first and be followed by the rescan's own, so the check repeats
        // after each publish until the deadline.
        Told::Rescan => {
            let deadline = Instant::now() + SETTLE_DEADLINE;
            loop {
                if client.index_publishes() > published {
                    let left = deleted_folder_leftovers(&mut client, root);
                    if left.is_empty() {
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "the deleted folder is still shown after the rescan's walk: {left:?}"
                    );
                }
                assert!(
                    Instant::now() < deadline,
                    "no index was published within {SETTLE_DEADLINE:?} of the rescan"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
