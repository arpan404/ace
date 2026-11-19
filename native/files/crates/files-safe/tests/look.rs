// SPDX-License-Identifier: Apache-2.0

//! Looking one name up in its folder: what a watcher asks thousands of times in a burst.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use files_safe::{Found, Readings, Root};

fn checkout() -> (tempfile::TempDir, Root) {
    let dir = tempfile::tempdir().expect("a temp dir");
    fs::create_dir_all(dir.path().join("many")).expect("a folder");
    let root = Root::open(dir.path()).expect("a root");
    (dir, root)
}

/// Whether the volume behind `dir` folds name case, asked the way the readings ask it: rename a
/// name's case and see whether the folder still answers under the old spelling.
fn volume_folds_case(dir: &Path) -> bool {
    let before = dir.join("CaseProbe.tmp");
    fs::write(&before, b"x").expect("a probe file");
    fs::rename(&before, dir.join("caseprobe.tmp")).expect("a case-only rename");
    let folds = before.exists();
    fs::remove_file(dir.join("caseprobe.tmp")).expect("the probe goes");
    folds
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
fn a_folder_replaced_after_it_was_read_answers_from_the_new_folder() {
    // A burst keeps a folder handle across thousands of names, and the folder can be renamed away
    // and another put in its place meanwhile. The handle must not answer for the new folder's
    // names, and the new folder's own names must be found.
    let (dir, root) = checkout();
    fs::write(dir.path().join("many/one.txt"), "x").expect("a file");
    let mut readings = Readings::new();
    assert_eq!(
        root.look("many/one.txt", &mut readings).expect("a file"),
        Found::Other,
        "the reading is primed while the folder is the first one"
    );

    fs::remove_dir_all(dir.path().join("many")).expect("the folder goes");
    fs::create_dir(dir.path().join("many")).expect("a new folder at the same name");
    fs::write(dir.path().join("many/two.txt"), "x").expect("a file in the new folder");

    assert_eq!(
        root.look("many/two.txt", &mut readings).expect("a file"),
        Found::Other,
        "a name in the folder that took the old folder's place"
    );
    assert_eq!(
        root.look("many/one.txt", &mut readings).expect("a name"),
        Found::Missing,
        "the replaced folder's file is not there any more"
    );
}

#[cfg(unix)]
#[test]
fn a_cached_folder_that_left_the_root_is_not_read() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let outside = tempfile::tempdir().expect("another temp dir");
    fs::create_dir_all(dir.path().join("many")).expect("a folder");
    fs::write(dir.path().join("many/one.txt"), "x").expect("a file");
    let root = Root::open(dir.path()).expect("a root");
    let mut readings = Readings::new();
    assert_eq!(
        root.look("many/one.txt", &mut readings).expect("a file"),
        Found::Other
    );

    fs::rename(dir.path().join("many"), outside.path().join("many")).expect("the move");
    std::os::unix::fs::symlink(outside.path().join("many"), dir.path().join("many"))
        .expect("a link out");

    let looked = root.look("many/one.txt", &mut readings);
    let refused = match &looked {
        Ok(found) => *found == Found::Missing,
        Err(_) => true,
    };
    assert!(
        refused,
        "a folder that left the root must not answer, saw {looked:?}"
    );
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
    if volume_folds_case(dir.path()) {
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
fn a_rename_reads_the_stored_names_again() {
    // The names a folder stores can be read before a rename and still hold the old spelling when
    // the new one is judged. The caller says a rename happened, and both spellings are then read
    // again: the new one is kept and the old one is gone.
    let (dir, root) = checkout();
    fs::write(dir.path().join("many/Readme.txt"), "x").expect("a file");
    let mut readings = Readings::new();
    assert_eq!(
        root.look("many/Readme.txt", &mut readings).expect("a file"),
        Found::Other,
        "the reading is primed before the rename"
    );

    fs::rename(
        dir.path().join("many/Readme.txt"),
        dir.path().join("many/readme.txt"),
    )
    .expect("a case-only rename");
    readings.renamed("many/readme.txt");
    if volume_folds_case(dir.path()) {
        assert_eq!(
            root.look("many/readme.txt", &mut readings)
                .expect("the new spelling"),
            Found::Other,
            "the new spelling is the one the folder stores now"
        );
        assert_eq!(
            root.look("many/Readme.txt", &mut readings).expect("a name"),
            Found::Renamed,
            "the old spelling is gone"
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
    if volume_folds_case(dir.path()) {
        assert_eq!(other, Found::Renamed, "the volume stores `Notes.MD`");
    } else {
        assert_eq!(other, Found::Missing, "the other spelling is another name");
    }
}

#[test]
#[ignore = "timing check: run in release, cargo test --release -p files-safe -- --ignored"]
fn a_burst_of_twenty_thousand_creates_costs_a_stat_a_look() {
    // The guard is against a folder listing, or a walk from the root, per event: a lookup may cost
    // its own stat and the one that proves the cached folder, and a floor of the same lookups made
    // with one plain stat each keeps the bound honest on a loaded machine.
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

    let started = Instant::now();
    let mut floor = Duration::ZERO;
    for set in 0..20 {
        for file in 0..1_000 {
            let path = root
                .path()
                .join(format!("burst/set_{set:02}/burst_{file:05}.txt"));
            let started = Instant::now();
            let found = fs::symlink_metadata(&path);
            floor += started.elapsed();
            assert!(found.expect("the burst file").is_file());
        }
    }
    let stat = floor / created;

    println!("look: {each:?} each over {created} creates, one stat {stat:?}");
    assert!(
        each < stat.saturating_mul(6),
        "a lookup costs {each:?}, six times the {stat:?} a bare stat costs"
    );
    assert!(
        each < Duration::from_millis(1),
        "a lookup costs {each:?}, which is a walk or a listing per create"
    );
}
