// SPDX-License-Identifier: Apache-2.0

//! Reading and writing bytes: the metadata-and-body read, guarded writes, and the mutations.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::{Client, checkout};
use files_wire::{Op, Reply};

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
