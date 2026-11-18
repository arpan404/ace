// SPDX-License-Identifier: Apache-2.0

//! Reading and writing bytes: the metadata-and-body read, guarded writes, and the mutations.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::fs;
use std::time::Duration;

use common::{Client, checkout};
use files_wire::{Message, Op, Reply};

#[test]
fn writes_then_reads_the_same_bytes() {
    let checkout = checkout(&[]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let write = client.request(Op::Write {
        root,
        path: "draft.txt".to_owned(),
        expected: None,
    });
    client.send_body(write, b"hello\n");
    let version = match client.reply(write) {
        Reply::Version { version } => version,
        other => panic!("write answered {other:?}"),
    };
    assert!(!version.is_empty(), "a write reports the new version");

    let read = client.request(Op::Read {
        root,
        path: "draft.txt".to_owned(),
        offset: 0,
        length: 1024,
        max_size: None,
    });
    let meta = match client.reply(read) {
        Reply::Read(meta) => meta,
        other => panic!("read answered {other:?}"),
    };
    assert!(meta.body, "the bytes follow as a body frame");
    assert_eq!(meta.size, 6);
    assert_eq!(meta.version, version);
    assert_eq!(meta.encoding, "UTF-8");
    assert!(!meta.binary);
    assert!(meta.eof);

    let (body, bytes) = client.next_body();
    assert_eq!(body, read, "the body belongs to the read response");
    assert_eq!(bytes, b"hello\n");
}

#[test]
fn refuses_a_read_larger_than_one_body_frame() {
    let checkout = checkout(&[("a.txt", "small\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Read {
        root,
        path: "a.txt".to_owned(),
        offset: 0,
        length: u64::from(files_wire::MAX_BODY_LEN) + 1,
        max_size: None,
    });
    let error = client.error(id);
    assert_eq!(error.code, "INVALID_ARGUMENT");
}

#[test]
fn cancel_sent_during_a_remove_still_answers_success() {
    // A tree big enough that the cancel lands while the removal is still running: the removal
    // happens either way, so its answer is `done` rather than a late `ABORTED`. Only a cancel that
    // arrives before the work starts may stop it.
    let checkout = checkout(&[]);
    let bulk = checkout.path().join("bulk");
    fs::create_dir(&bulk).expect("the folder");
    for index in 0..20_000 {
        fs::write(bulk.join(format!("file{index}.txt")), b"").expect("the file");
    }
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let removed = client.request(Op::Remove {
        root,
        path: "bulk".to_owned(),
    });
    // Long enough that the request has left the dispatcher and its worker is in the tree, far too
    // short for twenty thousand files to be gone.
    std::thread::sleep(Duration::from_millis(50));
    client.send(&Message::Cancel { id: removed });

    assert_eq!(client.reply(removed), Reply::Done);
    let after = client.request(Op::Stat {
        root,
        path: "bulk".to_owned(),
    });
    assert_eq!(client.error(after).code, "NOT_FOUND");
}

#[test]
fn a_write_from_a_stale_version_conflicts_with_the_current_one() {
    let checkout = checkout(&[]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let first = client.request(Op::CreateFile {
        root,
        path: "notes.txt".to_owned(),
    });
    client.send_body(first, b"one\n");
    let version = match client.reply(first) {
        Reply::Version { version } => version,
        other => panic!("createFile answered {other:?}"),
    };

    let stale = client.request(Op::Write {
        root,
        path: "notes.txt".to_owned(),
        expected: Some("0:0:0:0:0".to_owned()),
    });
    client.send_body(stale, b"two\n");
    let error = client.error(stale);
    assert_eq!(error.code, "CONFLICT");
    assert_eq!(
        error.current.as_deref(),
        Some(version.as_str()),
        "the conflict names the version the file has now"
    );

    // The current version saves, so the daemon can offer the reload or the overwrite.
    let fresh = client.request(Op::Write {
        root,
        path: "notes.txt".to_owned(),
        expected: Some(version),
    });
    client.send_body(fresh, b"two\n");
    assert!(matches!(client.reply(fresh), Reply::Version { .. }));
}

#[test]
fn creates_moves_and_removes_a_folder() {
    let checkout = checkout(&[]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let created = client.request(Op::CreateDir {
        root,
        path: "notes".to_owned(),
    });
    assert_eq!(client.reply(created), Reply::Done);

    let file = client.request(Op::CreateFile {
        root,
        path: "notes/a.txt".to_owned(),
    });
    client.send_body(file, b"kept\n");
    assert!(matches!(client.reply(file), Reply::Version { .. }));

    let moved = client.request(Op::Rename {
        root,
        from: "notes/a.txt".to_owned(),
        to: "notes/b.txt".to_owned(),
        overwrite: false,
    });
    assert_eq!(client.reply(moved), Reply::Done);
    let stat = client.request(Op::Stat {
        root,
        path: "notes/b.txt".to_owned(),
    });
    assert!(matches!(client.reply(stat), Reply::Entry(_)));

    let removed = client.request(Op::Remove {
        root,
        path: "notes".to_owned(),
    });
    assert_eq!(client.reply(removed), Reply::Done);
    let gone = client.request(Op::Stat {
        root,
        path: "notes/b.txt".to_owned(),
    });
    assert_eq!(client.error(gone).code, "NOT_FOUND");
}

#[test]
fn describes_a_file_and_a_folder_the_way_the_daemon_does() {
    let checkout = checkout(&[("docs/a.md", "aaaa\n"), ("docs/nested/b.md", "bb\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Describe {
        root,
        path: "docs/a.md".to_owned(),
    });
    let file = client.reply(request);
    let Reply::Description(file) = file else {
        panic!("describe answered {file:?}");
    };
    assert_eq!(file.size, 5);
    assert_eq!(file.mode & 0o777, 0o644);
    assert!(matches!(file.kind, files_wire::Kind::File));

    let request = client.request(Op::Describe {
        root,
        path: "docs".to_owned(),
    });
    let folder = client.reply(request);
    let Reply::Description(folder) = folder else {
        panic!("describe answered {folder:?}");
    };
    assert!(matches!(folder.kind, files_wire::Kind::Directory));
    assert!(
        folder.version.starts_with("tree:"),
        "a folder version digests its tree: {}",
        folder.version
    );

    let missing = client.request(Op::Describe {
        root,
        path: "docs/gone.md".to_owned(),
    });
    assert_eq!(client.error(missing).code, "NOT_FOUND");
}

#[test]
fn measures_the_bytes_a_delete_would_reserve() {
    let checkout = checkout(&[("docs/a.md", "aaaa\n"), ("docs/nested/b.md", "bb\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Measure {
        root,
        path: "docs".to_owned(),
    });
    let measured = client.reply(request);
    let Reply::Measure { bytes } = measured else {
        panic!("measure answered {measured:?}");
    };
    assert_eq!(bytes, 8);

    let request = client.request(Op::Measure {
        root,
        path: "docs/a.md".to_owned(),
    });
    let file = client.reply(request);
    assert_eq!(file, Reply::Measure { bytes: 5 });
}
