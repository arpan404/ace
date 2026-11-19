// SPDX-License-Identifier: Apache-2.0

//! Looking one name up in its folder: what a watcher asks thousands of times in a burst.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::fs;
use std::time::{Duration, Instant};

use files_safe::{Found, Readings, Root};

fn checkout() -> (tempfile::TempDir, Root) {
    let dir = tempfile::tempdir().expect("a temp dir");
    fs::create_dir_all(dir.path().join("many")).expect("a folder");
    let root = Root::open(dir.path()).expect("a root");
    (dir, root)
}

#[test]
fn reports_what_a_folder_holds_without_following_the_name() {
    let dir = tempfile::tempdir().expect("a temp dir");
    fs::create_dir_all(dir.path().join("src/deep")).expect("folders");
    fs::write(dir.path().join("src/deep/file.txt"), "x").expect("a file");
    fs::write(dir.path().join("top.txt"), "x").expect("a file");
    let root = Root::open(dir.path()).expect("a root");
    let mut readings = Readings::new();

    assert_eq!(
        root.look("src/deep", &mut readings).expect("a folder"),
        Found::Folder
    );
    assert_eq!(
        root.look("src/deep/file.txt", &mut readings)
            .expect("a file"),
        Found::Other
    );
    assert_eq!(
        root.look("top.txt", &mut readings).expect("a file"),
        Found::Other
    );
    assert_eq!(
        root.look("src/missing.txt", &mut readings)
            .expect("a missing name is not an error"),
        Found::Missing
    );
    assert_eq!(
        root.look("top.txt/inside", &mut readings)
            .expect_err("a file is not a folder")
            .code(),
        "NOT_DIRECTORY"
    );
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_reported_as_itself() {
    let dir = tempfile::tempdir().expect("a temp dir");
    fs::create_dir_all(dir.path().join("real")).expect("folders");
    std::os::unix::fs::symlink("real", dir.path().join("link")).expect("a folder link");
    let root = Root::open(dir.path()).expect("a root");
    let mut readings = Readings::new();

    assert_eq!(
        root.look("link", &mut readings).expect("a link"),
        Found::Other,
        "a link is never the folder it points at"
    );
}

#[test]
fn a_file_created_after_the_folder_was_read_is_still_seen() {
    // A burst holds one reading of a folder across thousands of creates: a name the reading does
    // not know yet is read live, and its spelling is the one the create stored.
    let (dir, root) = checkout();
    let mut readings = Readings::new();
    fs::write(dir.path().join("many/one.txt"), "x").expect("a file");
    assert_eq!(
        root.look("many/one.txt", &mut readings).expect("a file"),
        Found::Other
    );

    for index in 0..100 {
        let path = format!("many/file{index}.txt");
        fs::write(dir.path().join(&path), "x").expect("a file");
        assert_eq!(
            root.look(&path, &mut readings).expect("a file"),
            Found::Other,
            "{path} is created after the folder was read"
        );
    }
}

#[test]
fn a_case_only_rename_leaves_the_old_spelling_gone() {
    let (dir, root) = checkout();
    fs::write(dir.path().join("many/Readme.txt"), "x").expect("a file");
    let mut readings = Readings::new();
    assert_eq!(
        root.look("many/Readme.txt", &mut readings).expect("a file"),
        Found::Other
    );

    fs::rename(
        dir.path().join("many/Readme.txt"),
        dir.path().join("many/readme.txt"),
    )
    .expect("a case-only rename");
    // The next batch reads the folder again, which is where the stored spelling comes from.
    readings.clear();
    let old = root.look("many/Readme.txt", &mut readings).expect("a name");
    assert_eq!(
        root.look("many/readme.txt", &mut readings)
            .expect("the new spelling"),
        Found::Other
    );
    if root.folds_case() {
        assert_eq!(
            old,
            Found::Renamed,
            "a volume that folds case answers the old spelling with the renamed entry"
        );
    } else {
        assert_eq!(
            old,
            Found::Missing,
            "a volume that keeps case no longer has the old spelling at all"
        );
    }
}

#[test]
fn a_name_that_only_differs_in_case_is_reported_as_it_is_stored() {
    let (dir, root) = checkout();
    fs::write(dir.path().join("many/Notes.MD"), "x").expect("a file");
    let mut readings = Readings::new();

    // The spelling the disk stores is found under either case on a volume that folds case, and
    // only under its own spelling on one that keeps case.
    assert_eq!(
        root.look("many/Notes.MD", &mut readings).expect("a file"),
        Found::Other
    );
    let other = root.look("many/NOTES.md", &mut readings).expect("a name");
    if root.folds_case() {
        assert_eq!(other, Found::Renamed, "the volume stores `Notes.MD`");
    } else {
        assert_eq!(other, Found::Missing, "the other spelling is another name");
    }
}

#[test]
#[ignore = "timing check: run in release, cargo test --release -p files-safe -- --ignored"]
fn a_burst_of_twenty_thousand_creates_costs_under_ten_microseconds_a_look() {
    let dir = tempfile::tempdir().expect("a temp dir");
    for set in 0..20 {
        fs::create_dir_all(dir.path().join(format!("burst/set_{set:02}"))).expect("a folder");
    }
    let root = Root::open(dir.path()).expect("a root");
    let mut readings = Readings::new();
    let mut looks = Duration::ZERO;
    let mut created = 0u32;
    for set in 0..20 {
        for file in 0..1_000 {
            let path = format!("burst/set_{set:02}/burst_{file:05}.txt");
            fs::write(root.path().join(&path), b"x").expect("a burst file");
            let started = Instant::now();
            let found = root.look(&path, &mut readings);
            looks += started.elapsed();
            assert_eq!(found.expect("a lookup"), Found::Other);
            created += 1;
        }
        // One watcher window per folder: the readings are dropped when a batch is delivered.
        readings.clear();
    }

    let each = looks / created;
    println!("look: {each:?} each over {created} creates");
    assert!(
        each < Duration::from_micros(10),
        "a create costs {each:?} to look up, over {created} creates"
    );
}
