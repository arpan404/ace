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

    assert_eq!(client.reply(removed), Reply::done());
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
    assert!(
        matches!(
            client.reply(created),
            Reply::Done {
                version: Some(_),
                ..
            }
        ),
        "a create reports the digest of the folder it made"
    );

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
        expected: None,
        own: None,
        staging: None,
    });
    assert!(
        matches!(
            client.reply(moved),
            Reply::Done {
                version: Some(_),
                ..
            }
        ),
        "a move reports the moved file's version"
    );
    let stat = client.request(Op::Stat {
        root,
        path: "notes/b.txt".to_owned(),
    });
    assert!(matches!(client.reply(stat), Reply::Entry(_)));

    let removed = client.request(Op::Remove {
        root,
        path: "notes".to_owned(),
    });
    assert_eq!(client.reply(removed), Reply::done());
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
        full: false,
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
        full: false,
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
        full: false,
    });
    assert_eq!(client.error(missing).code, "NOT_FOUND");
}

#[test]
fn fingerprints_a_files_bytes_without_sending_them() {
    let checkout = checkout(&[
        ("one.txt", "same bytes\n"),
        ("two.txt", "same bytes\n"),
        ("folder/kept.txt", ""),
    ]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Fingerprint {
        root,
        path: "one.txt".to_owned(),
    });
    let Reply::Fingerprint {
        version,
        size,
        digest,
    } = client.reply(request)
    else {
        panic!("fingerprint answered");
    };
    assert_eq!(size, 11);
    assert!(digest.starts_with("sha256:"), "{digest}");

    let request = client.request(Op::Fingerprint {
        root,
        path: "two.txt".to_owned(),
    });
    let Reply::Fingerprint { digest: same, .. } = client.reply(request) else {
        panic!("fingerprint answered");
    };
    assert_eq!(digest, same, "identical bytes digest the same");

    let stat = client.request(Op::Stat {
        root,
        path: "one.txt".to_owned(),
    });
    let Reply::Entry(entry) = client.reply(stat) else {
        panic!("stat answered");
    };
    assert_eq!(entry.size, size);

    // The digest is the entry's own version, so a caller storing both never compares two states.
    let described = client.request(Op::DescribeEntry {
        root,
        path: "one.txt".to_owned(),
        internal: false,
    });
    let Reply::Description(described) = client.reply(described) else {
        panic!("describeEntry answered");
    };
    assert_eq!(described.version, version);

    let folder = client.request(Op::Fingerprint {
        root,
        path: "folder".to_owned(),
    });
    assert_eq!(client.error(folder).code, "NOT_FILE");

    let missing = client.request(Op::Fingerprint {
        root,
        path: "gone.txt".to_owned(),
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
    let Reply::Measure { bytes, shallow } = measured else {
        panic!("measure answered {measured:?}");
    };
    assert_eq!(bytes, 8);
    assert!(!shallow);

    let request = client.request(Op::Measure {
        root,
        path: "docs/a.md".to_owned(),
    });
    let file = client.reply(request);
    assert_eq!(
        file,
        Reply::Measure {
            bytes: 5,
            shallow: false
        }
    );
}

#[test]
fn describes_an_entry_without_walking_its_folder() {
    let checkout = checkout(&[("docs/a.md", "aaaa\n"), ("docs/nested/b.md", "bb\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Describe {
        root,
        path: "docs".to_owned(),
        full: false,
    });
    let Reply::Description(folder) = client.reply(request) else {
        panic!("describe answered");
    };
    let request = client.request(Op::DescribeEntry {
        root,
        path: "docs".to_owned(),
        internal: false,
    });
    let Reply::Description(entry) = client.reply(request) else {
        panic!("describeEntry answered");
    };

    assert!(folder.version.starts_with("tree:"));
    assert_eq!(folder.own_version.as_deref(), Some(entry.version.as_str()));
    assert_eq!(entry.version, folder.own_version.expect("an own version"));
    assert!(!entry.shallow);
    assert!(entry.own_version.is_none());
}

// The budget comes from the binary's `test-hooks` feature, so this test runs only with it.
#[cfg(feature = "test-hooks")]
#[test]
fn a_describe_over_the_walk_budget_says_it_is_shallow() {
    // The budget comes from the binary's test hook, so a small tree shows the fallback a huge
    // folder like node_modules takes.
    let checkout = checkout(&[]);
    for index in 0..25 {
        common::write_file(checkout.path(), &format!("big/{index}.md"), "x");
    }
    let mut client = Client::launch(&[("ACE_FILES_WALK_BUDGET", "10")], false);
    client.hello();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Describe {
        root,
        path: "big".to_owned(),
        full: false,
    });
    let Reply::Description(description) = client.reply(request) else {
        panic!("describe answered");
    };
    assert!(description.shallow, "{description:?}");
    assert!(!description.version.starts_with("tree:"));
    assert_eq!(
        description.own_version.as_deref(),
        Some(description.version.as_str()),
        "the own version stands in for the digest it did not take"
    );

    let request = client.request(Op::Measure {
        root,
        path: "big".to_owned(),
    });
    let Reply::Measure { bytes, shallow } = client.reply(request) else {
        panic!("measure answered");
    };
    assert!(
        !shallow,
        "the trash quota counts every byte, so its measure has no walk budget"
    );
    assert_eq!(bytes, 25, "every one-byte file is counted");
}

#[test]
fn cancel_stops_a_describe_of_a_large_folder() {
    // Enough entries that the walk outlasts the round trip of the cancel that follows it.
    let checkout = checkout(&[]);
    for index in 0..2_000 {
        common::write_file(checkout.path(), &format!("many/file{index:04}.md"), "");
    }
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Describe {
        root,
        path: "many".to_owned(),
        full: false,
    });
    client.send(&Message::Cancel { id });

    assert_eq!(client.error(id).code, "ABORTED");
}

#[test]
fn a_mutation_refuses_a_link_on_the_way_in_one_step() {
    let checkout = checkout(&[("docs/a.md", "a\n")]);
    let outside = tempfile::tempdir().expect("outside dir");
    std::fs::write(outside.path().join("secret"), "secret").expect("write");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("docs", checkout.path().join("alias")).expect("link");
        std::os::unix::fs::symlink(outside.path().join("secret"), checkout.path().join("away"))
            .expect("link");
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir("docs", checkout.path().join("alias")).expect("link");
    }
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    for (path, code) in [
        ("alias/new.md", "PATH_ESCAPE"),
        ("away", "PATH_ESCAPE"),
        ("gone/new.md", "NOT_FOUND"),
        ("docs/a.md/below", "NOT_DIRECTORY"),
    ] {
        let id = client.request(Op::CreateDir {
            root,
            path: path.to_owned(),
        });
        assert_eq!(client.error(id).code, code, "{path}");
    }
    let created = client.request(Op::CreateDir {
        root,
        path: "docs/new".to_owned(),
    });
    assert!(matches!(
        client.reply(created),
        Reply::Done {
            version: Some(_),
            ..
        }
    ));
}

#[test]
fn trashes_and_restores_through_the_generated_endpoint() {
    let checkout = checkout(&[("docs/a.md", "kept\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let request = client.request(Op::Describe {
        root,
        path: "docs".to_owned(),
        full: true,
    });
    let description = match client.reply(request) {
        Reply::Description(description) => description,
        other => panic!("describe answered {other:?}"),
    };

    let trashed = client.request(Op::Trash {
        root,
        path: "docs".to_owned(),
        endpoint: ".ace-upload-trash-wire".to_owned(),
        expected: description.version.clone(),
        own: description.own_version.clone(),
    });
    assert_eq!(client.reply(trashed), Reply::done());
    assert!(!checkout.path().join("docs").exists());

    let restored = client.request(Op::Untrash {
        root,
        endpoint: ".ace-upload-trash-wire".to_owned(),
        path: "docs".to_owned(),
    });
    assert_eq!(client.reply(restored), Reply::done());
    assert_eq!(
        std::fs::read(checkout.path().join("docs/a.md")).expect("the restored file"),
        b"kept\n"
    );
}

#[test]
fn a_read_and_a_listing_never_serve_a_link_into_the_daemons_names() {
    let checkout = checkout(&[("notes.md", "notes\n")]);
    std::fs::create_dir_all(checkout.path().join(".git")).expect("git");
    std::fs::write(checkout.path().join(".git/config"), "[core]\n").expect("write");
    common::write_file(checkout.path(), ".ace-upload-trash-9/kept.md", "deleted\n");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(".git/config", checkout.path().join("config-link"))
            .expect("link");
        std::os::unix::fs::symlink(".git", checkout.path().join("git-link")).expect("link");
        std::os::unix::fs::symlink(".ace-upload-trash-9", checkout.path().join("trash-link"))
            .expect("link");
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(".git/config", checkout.path().join("config-link"))
            .expect("link");
        std::os::windows::fs::symlink_dir(".git", checkout.path().join("git-link")).expect("link");
    }
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    for operation in [
        Op::Read {
            root,
            path: "config-link".to_owned(),
            offset: 0,
            length: 16,
            max_size: None,
        },
        Op::Stat {
            root,
            path: "config-link".to_owned(),
        },
        Op::Stat {
            root,
            path: "git-link".to_owned(),
        },
        Op::Describe {
            root,
            path: "config-link".to_owned(),
            full: false,
        },
        Op::List {
            root,
            dir: "git-link".to_owned(),
            limit: 10,
            cursor: None,
            hide: Vec::new(),
            snapshot: false,
        },
        Op::List {
            root,
            dir: "trash-link".to_owned(),
            limit: 10,
            cursor: None,
            hide: Vec::new(),
            snapshot: false,
        },
    ] {
        let id = client.request(operation);
        assert_eq!(client.error(id).code, "INVALID_PATH");
    }
}

// The budget comes from the binary's `test-hooks` feature, so this test runs only with it.
#[cfg(feature = "test-hooks")]
#[test]
fn a_verified_delete_walks_the_moved_tree_past_the_display_budget() {
    let checkout = checkout(&[]);
    for index in 0..25 {
        common::write_file(checkout.path(), &format!("big/{index}.md"), "x");
    }
    let mut client = Client::launch(&[("ACE_FILES_WALK_BUDGET", "10")], false);
    client.hello();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Describe {
        root,
        path: "big".to_owned(),
        full: true,
    });
    let description = match client.reply(request) {
        Reply::Description(description) => description,
        other => panic!("describe answered {other:?}"),
    };
    let trashed = client.request(Op::Trash {
        root,
        path: "big".to_owned(),
        endpoint: ".ace-upload-trash-budget".to_owned(),
        expected: description.version,
        own: description.own_version,
    });
    assert_eq!(
        client.reply(trashed),
        Reply::done(),
        "the post-move verification is not stopped by the display budget"
    );
    assert!(!checkout.path().join("big").exists());
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_full_describe_walks_past_the_display_budget() {
    let checkout = checkout(&[]);
    for index in 0..25 {
        common::write_file(checkout.path(), &format!("big/{index}.md"), "x");
    }
    let mut client = Client::launch(&[("ACE_FILES_WALK_BUDGET", "10")], false);
    client.hello();
    let root = client.open_root(checkout.path());

    let request = client.request(Op::Describe {
        root,
        path: "big".to_owned(),
        full: false,
    });
    let display = match client.reply(request) {
        Reply::Description(description) => description,
        other => panic!("describe answered {other:?}"),
    };
    assert!(display.shallow, "a display stat keeps the budget");

    let request = client.request(Op::Describe {
        root,
        path: "big".to_owned(),
        full: true,
    });
    let guard = match client.reply(request) {
        Reply::Description(description) => description,
        other => panic!("describe answered {other:?}"),
    };
    assert!(!guard.shallow, "a guarded describe walks the whole tree");
    assert!(guard.version.starts_with("tree:"), "{guard:?}");
}

/// An interrupted save's record, the shape `files-io` writes before its swap.
#[cfg(unix)]
fn journal(target: &str, staging: &str, staged: (u64, u64), displaced: (u64, u64)) -> String {
    format!(
        "1\0{target}\0{staging}\0\0{}:{}\0{}:{}",
        staged.0, staged.1, displaced.0, displaced.1
    )
}

#[cfg(unix)]
fn identity(path: &std::path::Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).expect("metadata");
    (metadata.dev(), metadata.ino())
}

#[cfg(unix)]
#[test]
fn opening_a_root_resolves_a_save_a_crash_interrupted() {
    let checkout = checkout(&[]);
    // The state a crash after the swap leaves: the new bytes hold the name, the version the save
    // displaced waits under a private one, and the record that names both is at the root.
    fs::write(
        checkout.path().join("interrupted.md"),
        b"the bytes that landed\n",
    )
    .expect("target");
    fs::write(
        checkout.path().join(".ace-upload-4242-1"),
        b"the version the caller read\n",
    )
    .expect("displaced");
    let staged = identity(&checkout.path().join("interrupted.md"));
    let displaced = identity(&checkout.path().join(".ace-upload-4242-1"));
    fs::write(
        checkout.path().join(".ace-upload-journal-4242-2"),
        journal("interrupted.md", ".ace-upload-4242-1", staged, displaced),
    )
    .expect("journal");

    let mut client = Client::greeted();
    client.open_root(checkout.path());

    // Opening the checkout is a start: the displaced version is visible and nothing private stays.
    let kept = fs::read_dir(checkout.path())
        .expect("list")
        .map(|entry| entry.expect("entry").file_name().into_string().unwrap())
        .find(|name| name.starts_with("interrupted.conflict-"))
        .expect("the displaced version is preserved under a visible name");
    assert_eq!(
        fs::read(checkout.path().join(&kept)).expect("read"),
        b"the version the caller read\n"
    );
    assert_eq!(
        fs::read(checkout.path().join("interrupted.md")).expect("read"),
        b"the bytes that landed\n"
    );
    let private: Vec<String> = fs::read_dir(checkout.path())
        .expect("list")
        .map(|entry| entry.expect("entry").file_name().into_string().unwrap())
        .filter(|name| name.starts_with(".ace-upload-") && name != ".ace-upload-journal-lock")
        .collect();
    assert!(private.is_empty(), "{private:?}");
}
