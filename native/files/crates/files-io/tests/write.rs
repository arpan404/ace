// SPDX-License-Identifier: Apache-2.0

mod common;

use common::Fixture;
use files_io::write;

#[test]
fn write_with_stale_version_conflicts() {
    let fixture = Fixture::new();
    fixture.write("notes.md", b"one\n");
    let stale = fixture.version("notes.md");
    let saved = write(fixture.root(), "notes.md", b"two\n", Some(&stale)).expect("first save");
    let saved = saved.version.expect("a committed save reports its version");
    assert_ne!(
        saved, stale,
        "a save replaces the file, so its version changes"
    );
    assert_eq!(fixture.read("notes.md"), b"two\n");

    let error = write(fixture.root(), "notes.md", b"three\n", Some(&stale))
        .expect_err("a stale version must be refused");
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("notes.md"), b"two\n");

    write(fixture.root(), "notes.md", b"three\n", Some(&saved))
        .expect("save with the current version");
    assert_eq!(fixture.read("notes.md"), b"three\n");
}

#[test]
fn write_with_a_version_for_a_missing_file_conflicts() {
    let fixture = Fixture::new();
    let error = write(fixture.root(), "new.md", b"content\n", Some("1:2:3:4:5"))
        .expect_err("a version for a file that is not there must be refused");
    assert_eq!(error.code(), "CONFLICT");
    assert!(!fixture.exists("new.md"));
}

#[test]
fn write_is_atomic_on_crash_simulated_by_temp_left_behind() {
    let fixture = Fixture::new();
    fixture.write("draft.md", b"first draft\n");
    // A crash after the temp copy was written and before the rename left it behind.
    fixture.write(".draft.md.crashed.tmp", b"a draft that never landed");
    let version = fixture.version("draft.md");

    write(
        fixture.root(),
        "draft.md",
        b"second draft that did land\n",
        Some(&version),
    )
    .expect("a save beside a crashed one still lands");

    assert_eq!(fixture.read("draft.md"), b"second draft that did land\n");
    assert_eq!(
        fixture.read(".draft.md.crashed.tmp"),
        b"a draft that never landed"
    );
}

#[cfg(unix)]
#[test]
fn write_keeps_file_mode() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    fixture.write("run.sh", b"#!/bin/sh\necho one\n");
    std::fs::set_permissions(
        fixture.path("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .expect("chmod");
    let version = fixture.version("run.sh");

    write(
        fixture.root(),
        "run.sh",
        b"#!/bin/sh\necho two\n",
        Some(&version),
    )
    .expect("save");

    let mode = std::fs::metadata(fixture.path("run.sh"))
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o755);
}

#[test]
fn write_refuses_a_folder() {
    let fixture = Fixture::new();
    files_io::create_dir(fixture.root(), "folder").expect("create a folder");
    let version = fixture.version("folder");
    let error = write(fixture.root(), "folder", b"text\n", Some(&version))
        .expect_err("a folder has no contents to replace");
    assert_eq!(error.code(), "NOT_FILE");
    assert!(fixture.dir().join("folder").is_dir());
}

#[test]
fn create_refuses_existing_file() {
    let fixture = Fixture::new();
    fixture.write("taken.txt", b"someone else's work\n");

    let error = files_io::create_file(fixture.root(), "taken.txt", b"replacement\n")
        .expect_err("create must not overwrite");
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("taken.txt"), b"someone else's work\n");

    let created = files_io::create_file(fixture.root(), "fresh.txt", b"new file\n")
        .expect("create a new file");
    assert_eq!(fixture.read("fresh.txt"), b"new file\n");
    assert_eq!(
        created.version.as_deref(),
        Some(fixture.version("fresh.txt").as_str())
    );
}

#[cfg(unix)]
#[test]
fn writing_onto_a_symlink_is_refused_and_keeps_the_link() {
    let fixture = Fixture::new();
    fixture.write("target.md", b"one\n");
    std::os::unix::fs::symlink("target.md", fixture.path("link.md")).expect("symlink");
    let version = fixture.version("link.md");

    let error = write(fixture.root(), "link.md", b"two\n", Some(&version))
        .expect_err("a save never crosses a link");

    assert_eq!(error.code(), "PATH_ESCAPE");
    let link = std::fs::symlink_metadata(fixture.path("link.md")).expect("stat the link");
    assert!(link.file_type().is_symlink(), "the link is still a link");
    assert_eq!(fixture.read("target.md"), b"one\n");
}

#[cfg(unix)]
#[test]
fn a_save_that_cannot_sync_the_folder_leaves_the_file_alone() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    fixture.write("draft.md", b"old\n");
    let version = fixture.version("draft.md");
    let folder = fixture.dir().to_path_buf();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o300)).expect("chmod");
    // Root can read a folder whatever its mode, so the failure cannot be staged there.
    let denied = std::fs::read_dir(&folder).is_err();

    let result = write(fixture.root(), "draft.md", b"new\n", Some(&version));
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).expect("chmod back");
    if !denied {
        return;
    }
    let error = result.expect_err("a folder that cannot be opened for syncing stops the save");
    assert_eq!(error.code(), "PERMISSION_DENIED");
    assert_eq!(
        fixture.read("draft.md"),
        b"old\n",
        "a save that cannot be made durable must not change the file"
    );
}

#[cfg(all(feature = "test-hooks", unix))]
#[test]
fn a_guarded_save_without_an_atomic_exchange_never_touches_the_target() {
    let fixture = Fixture::new();
    fixture.write("atomic-only.md", b"old\n");
    let version = fixture.version("atomic-only.md");
    let _hook = files_io::test_hooks::refuse_exchange(&["atomic-only.md"]);

    let error = write(fixture.root(), "atomic-only.md", b"new\n", Some(&version))
        .expect_err("a save that cannot be swapped in atomically is refused");

    assert_eq!(error.code(), "UNSUPPORTED");
    assert_eq!(
        fixture.read("atomic-only.md"),
        b"old\n",
        "the target is untouched: no replacing rename is used instead"
    );
    let leftovers: Vec<String> = std::fs::read_dir(fixture.dir())
        .expect("list")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.starts_with(".ace-upload-") && name != ".ace-upload-journal-lock")
        .collect();
    assert!(
        leftovers.is_empty(),
        "no staging file is left: {leftovers:?}"
    );
}

/// Every name in `dir` the daemon keeps out of a listing.
#[cfg(all(feature = "test-hooks", unix))]
#[allow(clippy::expect_used)]
fn private_names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("list")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.starts_with(".ace-upload-") && name != ".ace-upload-journal-lock")
        .collect();
    names.sort();
    names
}

#[cfg(all(feature = "test-hooks", unix))]
#[test]
fn a_crash_after_a_save_swapped_keeps_the_version_it_replaced_visible() {
    use files_io::SaveRecovery;
    use files_io::test_hooks::{Step, halt_at};

    let fixture = Fixture::new();
    fixture.write("saved.md", b"the version the caller read\n");
    let version = fixture.version("saved.md");
    let _hook = halt_at(Step::AfterSaveSwap, "saved.md");

    // The crash lands after the exchange: the new bytes hold the name and the version the caller
    // replaced waits under a private name no listing shows.
    let error = write(
        fixture.root(),
        "saved.md",
        b"the bytes that landed\n",
        Some(&version),
    )
    .expect_err("the save stops where the crash would");
    assert_eq!(error.code(), "ABORTED");
    assert_eq!(fixture.read("saved.md"), b"the bytes that landed\n");
    assert!(
        private_names(fixture.dir())
            .iter()
            .any(|name| name.starts_with(".ace-upload-journal-")),
        "the save wrote its journal before the swap"
    );

    let outcomes = files_io::reconcile_saves(fixture.root()).expect("resolve the record");
    let Some(SaveRecovery::Preserved { at, .. }) = outcomes.first() else {
        panic!("the displaced version is preserved visibly: {outcomes:?}");
    };
    assert_eq!(
        fixture.read(at),
        b"the version the caller read\n",
        "the version this save replaced is kept whole"
    );
    assert_eq!(fixture.read("saved.md"), b"the bytes that landed\n");
    assert!(
        private_names(fixture.dir()).is_empty(),
        "no private name and no record is left: {:?}",
        private_names(fixture.dir())
    );
}

#[cfg(all(feature = "test-hooks", unix))]
#[test]
fn a_crash_before_a_save_swapped_removes_the_copy_it_had_staged() {
    use files_io::SaveRecovery;
    use files_io::test_hooks::{Step, halt_at};

    let fixture = Fixture::new();
    fixture.write("pending.md", b"the version the caller read\n");
    let version = fixture.version("pending.md");
    let _hook = halt_at(Step::BeforeSaveSwap, "pending.md");

    let error = write(
        fixture.root(),
        "pending.md",
        b"a copy that never landed\n",
        Some(&version),
    )
    .expect_err("the save stops where the crash would");
    assert_eq!(error.code(), "ABORTED");
    assert_eq!(
        fixture.read("pending.md"),
        b"the version the caller read\n",
        "the name still holds the caller's version"
    );
    let crashed = private_names(fixture.dir());
    assert!(
        crashed
            .iter()
            .any(|name| name.starts_with(".ace-upload-journal-"))
            && crashed
                .iter()
                .any(|name| !name.starts_with(".ace-upload-journal-")),
        "the staged copy and the journal are both on disk: {crashed:?}"
    );

    let outcomes = files_io::reconcile_saves(fixture.root()).expect("resolve the record");
    assert_eq!(
        outcomes,
        vec![SaveRecovery::Discarded {
            path: "pending.md".to_owned()
        }]
    );
    assert_eq!(fixture.read("pending.md"), b"the version the caller read\n");
    assert!(
        private_names(fixture.dir()).is_empty(),
        "the uncommitted copy is removed: {:?}",
        private_names(fixture.dir())
    );
}

#[cfg(all(feature = "test-hooks", unix))]
#[test]
fn a_crash_that_left_the_name_free_puts_the_displaced_version_back() {
    use files_io::SaveRecovery;
    use files_io::test_hooks::{Step, halt_at};

    let fixture = Fixture::new();
    fixture.write("freed.md", b"the version the caller read\n");
    let version = fixture.version("freed.md");
    let _hook = halt_at(Step::AfterSaveSwap, "freed.md");
    write(
        fixture.root(),
        "freed.md",
        b"the bytes that landed\n",
        Some(&version),
    )
    .expect_err("the save stops where the crash would");
    // The name goes before the start that resolves the record, as a move-aside on another volume
    // would leave it while the old entry waits under the private name.
    std::fs::remove_file(fixture.path("freed.md")).expect("free the name");

    let outcomes = files_io::reconcile_saves(fixture.root()).expect("resolve the record");
    assert_eq!(
        outcomes,
        vec![SaveRecovery::Restored {
            path: "freed.md".to_owned()
        }]
    );
    assert_eq!(
        fixture.read("freed.md"),
        b"the version the caller read\n",
        "the displaced version is back at its own name"
    );
    assert!(
        private_names(fixture.dir()).is_empty(),
        "{:?}",
        private_names(fixture.dir())
    );
}

#[test]
fn a_start_waits_for_a_save_that_holds_the_checkout_lock() {
    use std::sync::mpsc;
    use std::time::Duration;

    let fixture = Fixture::new();
    // A record on disk is what a start would replay; the lock is what makes it wait for the save.
    fixture.write(
        ".ace-upload-journal-999-1",
        b"1\x00doc.md\x00.ace-upload-999-2\x00\x001:2\x003:4",
    );
    let held = files_io::lock_saves(fixture.root()).expect("hold the checkout's save lock");
    let (finished, waited) = mpsc::channel();
    let path = fixture.dir().to_path_buf();
    let starter = std::thread::spawn(move || {
        let root = files_safe::Root::open(&path).expect("open the checkout");
        let resolved = files_io::reconcile_saves(&root).is_ok();
        let _ = finished.send(resolved);
    });

    // A second helper must not reconcile a save whose swap is still in flight.
    assert!(
        waited.recv_timeout(Duration::from_millis(250)).is_err(),
        "a start must wait for the save that holds the checkout's lock"
    );
    drop(held);
    assert!(
        waited
            .recv_timeout(Duration::from_secs(10))
            .expect("the waiting start finishes"),
        "the start resolves the checkout once the lock is free"
    );
    starter.join().expect("the start thread");
}

#[cfg(all(feature = "test-hooks", unix))]
#[test]
fn a_start_keeps_an_entry_the_record_cannot_prove_under_a_visible_name() {
    use files_io::SaveRecovery;
    use files_io::test_hooks::{Step, halt_at};

    let fixture = Fixture::new();
    fixture.write("unknown.md", b"the version the caller read\n");
    let version = fixture.version("unknown.md");
    let _hook = halt_at(Step::AfterSaveSwap, "unknown.md");
    write(
        fixture.root(),
        "unknown.md",
        b"the bytes that landed\n",
        Some(&version),
    )
    .expect_err("the save stops where the crash would");
    // The private name no longer holds the entry the record proves: another program's entry sits
    // where the displaced one was. It is still an entry this save moved out of the name.
    let staging = private_names(fixture.dir())
        .into_iter()
        .find(|name| !name.starts_with(".ace-upload-journal-"))
        .expect("the displaced entry waits under a private name");
    std::fs::remove_file(fixture.path(&staging)).expect("clear the name");
    std::fs::write(
        fixture.path(&staging),
        b"an entry the record cannot prove\n",
    )
    .expect("plant");

    let outcomes = files_io::reconcile_saves(fixture.root()).expect("resolve the record");
    let Some(SaveRecovery::Preserved { at, .. }) = outcomes.first() else {
        panic!("the entry is kept where a person can see it: {outcomes:?}");
    };
    assert_eq!(
        fixture.read(at),
        b"an entry the record cannot prove\n",
        "the entry is preserved whole"
    );
    assert!(
        private_names(fixture.dir()).is_empty(),
        "nothing stays under a private name: {:?}",
        private_names(fixture.dir())
    );
    assert_eq!(fixture.read("unknown.md"), b"the bytes that landed\n");
}
