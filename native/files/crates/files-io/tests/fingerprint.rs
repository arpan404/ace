// SPDX-License-Identifier: Apache-2.0

mod common;

use common::Fixture;
use files_io::fingerprint;

#[test]
fn a_same_size_edit_with_a_restored_mtime_gets_a_new_digest() {
    let fixture = Fixture::new();
    fixture.write("same.txt", b"aaaa");
    fixture.set_modified("same.txt", 1_700_000_000, 123_000_000);
    let before = fingerprint(fixture.root(), "same.txt").expect("the first bytes");

    // The edit keeps the size and puts the modification time back: everything a version records
    // about the entry is where it was, and only the bytes moved.
    fixture.write("same.txt", b"bbbb");
    fixture.set_modified("same.txt", 1_700_000_000, 123_000_000);
    let after = fingerprint(fixture.root(), "same.txt").expect("the edited bytes");

    assert_eq!(before.size, after.size);
    assert_ne!(before.digest, after.digest, "the content moved");
}

#[test]
fn the_digest_names_the_bytes_and_the_version_they_had() {
    let fixture = Fixture::new();
    fixture.write("one.txt", b"same bytes\n");
    fixture.write("two.txt", b"same bytes\n");
    fixture.write("other.txt", b"other bytes\n");

    let one = fingerprint(fixture.root(), "one.txt").expect("one");
    let two = fingerprint(fixture.root(), "two.txt").expect("two");
    let other = fingerprint(fixture.root(), "other.txt").expect("other");

    assert_eq!(one.digest, two.digest, "identical bytes digest the same");
    assert_ne!(one.digest, other.digest);
    assert_eq!(one.size, 11);
    assert!(one.digest.starts_with("sha256:"), "{}", one.digest);
    assert_eq!(one.version, fixture.version("one.txt"));
}

#[test]
fn only_a_file_has_a_content_digest() {
    let fixture = Fixture::new();
    fixture.write("folder/file.txt", b"x");

    let folder = fingerprint(fixture.root(), "folder").expect_err("a folder has no bytes");
    assert_eq!(folder.code(), "NOT_FILE");

    let missing = fingerprint(fixture.root(), "gone.txt").expect_err("nothing is there");
    assert_eq!(missing.code(), "NOT_FOUND");
}

#[cfg(unix)]
#[test]
fn a_fingerprint_holds_the_same_policy_as_a_read() {
    let fixture = Fixture::new();
    fixture.write(".git/config", b"[core]\n");
    fixture.write("notes.txt", b"notes\n");
    std::fs::write(fixture.dir().join("notes.txt"), b"notes\n").expect("notes");
    std::os::unix::fs::symlink("notes.txt", fixture.path("fine.txt")).expect("inside link");
    std::os::unix::fs::symlink(".git/config", fixture.path("secret.txt")).expect("git link");

    let inside = fingerprint(fixture.root(), "fine.txt").expect("a link inside the root reads");
    assert_eq!(inside.size, 6);

    let reserved = fingerprint(fixture.root(), "secret.txt").expect_err("git's store is refused");
    assert_eq!(reserved.code(), "INVALID_PATH");
}
