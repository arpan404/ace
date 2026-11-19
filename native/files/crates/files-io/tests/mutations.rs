// SPDX-License-Identifier: Apache-2.0

mod common;

use common::Fixture;

#[test]
fn rename_never_replaces_an_existing_destination() {
    let fixture = Fixture::new();
    fixture.write("a.txt", b"a\n");
    fixture.write("b.txt", b"b\n");

    let error = files_io::rename(fixture.root(), "a.txt", "b.txt", None, None)
        .expect_err("an existing destination must be refused");
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("a.txt"), b"a\n");
    assert_eq!(fixture.read("b.txt"), b"b\n");

    files_io::rename(fixture.root(), "a.txt", "c.txt", None, None).expect("rename to a free name");
    assert!(!fixture.exists("a.txt"));
    assert_eq!(fixture.read("c.txt"), b"a\n");
}

#[test]
fn rename_moves_a_folder_with_its_contents() {
    let fixture = Fixture::new();
    fixture.write("before/nested/deep.txt", b"deep\n");
    files_io::rename(fixture.root(), "before", "after", None, None).expect("rename the folder");
    assert!(!fixture.exists("before"));
    assert_eq!(fixture.read("after/nested/deep.txt"), b"deep\n");
}

#[test]
fn rename_of_a_missing_file_is_not_found() {
    let fixture = Fixture::new();
    let error = files_io::rename(fixture.root(), "missing.txt", "other.txt", None, None)
        .expect_err("nothing to move");
    assert_eq!(error.code(), "NOT_FOUND");
}

#[test]
fn rename_moves_between_folders_without_replacing() {
    let fixture = Fixture::new();
    fixture.write("a/one.txt", b"one\n");
    fixture.write("b/two.txt", b"two\n");

    files_io::rename(fixture.root(), "a/one.txt", "b/three.txt", None, None).expect("move into b");
    assert!(!fixture.exists("a/one.txt"));
    assert_eq!(fixture.read("b/three.txt"), b"one\n");

    let error = files_io::rename(fixture.root(), "b/three.txt", "b/two.txt", None, None)
        .expect_err("b/two.txt exists");
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("b/two.txt"), b"two\n");
    assert_eq!(fixture.read("b/three.txt"), b"one\n");
}

#[test]
fn rename_into_its_own_subfolder_is_invalid() {
    let fixture = Fixture::new();
    fixture.write("dir/inside.txt", b"inside\n");

    let error = files_io::rename(fixture.root(), "dir", "dir/moved", None, None)
        .expect_err("a folder cannot be moved inside itself");

    assert_eq!(error.code(), "INVALID_ARGUMENT");
    assert_eq!(fixture.read("dir/inside.txt"), b"inside\n");
}

#[test]
fn case_only_rename_is_allowed_where_the_volume_ignores_case() {
    let fixture = Fixture::new();
    fixture.write("Notes.md", b"case matters\n");
    if !ignores_case(fixture.dir()) {
        eprintln!("this volume is case-sensitive; skipping case_only_rename");
        return;
    }

    files_io::rename(fixture.root(), "Notes.md", "notes.md", None, None)
        .expect("a case-only rename");

    assert_eq!(fixture.read("notes.md"), b"case matters\n");
    let names: Vec<String> = std::fs::read_dir(fixture.dir())
        .expect("list the root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, ["notes.md"], "only the spelling on disk changes");
}

/// Whether `dir` is on a volume that treats two spellings of one name as the same file.
#[allow(clippy::expect_used)]
fn ignores_case(dir: &std::path::Path) -> bool {
    let probe = dir.join("CaseProbe.txt");
    std::fs::write(&probe, b"probe").expect("write probe");
    let ignores = dir.join("caseprobe.txt").exists();
    std::fs::remove_file(&probe).expect("remove probe");
    ignores
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_case_only_rename_never_replaces_a_name_that_appears_between_its_steps() {
    use files_io::test_hooks::{Step, report_taken, watch};

    let fixture = Fixture::new();
    // The names are unique to this test: every watcher in the process sees every move, and two
    // tests sharing a spelling would write into each other's fixtures.
    fixture.write("RaceNotes.md", b"the original\n");
    let folder = fixture.dir().to_path_buf();
    // A volume that folds both spellings together reports the destination as taken, so the entry
    // has to travel through a staging name. Between the two steps both names are free, and a
    // replacing rename there would silently discard what another writer put at the destination.
    let _taken = report_taken("RaceNotes.md", "racenotes.md");
    let _hook = watch(move |step, from, _to| {
        if step == Step::BetweenMoveSteps && from == "RaceNotes.md" {
            std::fs::write(folder.join("racenotes.md"), b"someone else\n").expect("squatter");
        }
    });

    let error = files_io::rename(fixture.root(), "RaceNotes.md", "racenotes.md", None, None)
        .expect_err("a move that could not be put back is its own outcome");

    let names: Vec<String> = std::fs::read_dir(fixture.dir())
        .expect("list the root")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    // The volume cannot hold both spellings, so the entry could not be put back: it is whole
    // under a name a person can see, and the failure names that very path.
    assert_eq!(error.code(), "STRANDED");
    let kept = names
        .iter()
        .find(|name| name.starts_with("RaceNotes.conflict-"))
        .expect("the entry is preserved under a visible name");
    assert_eq!(
        error.recovery().as_deref(),
        Some(kept.as_str()),
        "the outcome carries the actual recovery path"
    );
    assert!(
        error.to_string().contains(kept.as_str()),
        "the message names it: {error}"
    );
    assert_eq!(fixture.read(kept), b"the original\n");
    assert!(
        !names
            .iter()
            .any(|name| name.starts_with(".ace-upload-move-")),
        "no private staging name is left behind: {names:?}"
    );
    assert_eq!(
        fixture.read("racenotes.md"),
        b"someone else\n",
        "the name that appeared is never replaced"
    );
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_moved_folder_must_be_the_entry_the_guard_was_taken_from() {
    use files_io::test_hooks::{Step, watch};

    let fixture = Fixture::new();
    fixture.write("docs/a.md", b"a\n");
    let description = files_io::describe(fixture.root(), "docs", &files_io::Walks::unbounded())
        .expect("describe");
    let own = description.own_version.clone().expect("own");
    let folder = fixture.dir().to_path_buf();
    // A folder that is not the one the guard described, but whose only entry is a hard link to
    // the same file, digests to the same tree: the digest alone cannot tell them apart.
    let _hook = watch(move |step, from, to| {
        if step == Step::AfterMove && from == "docs" && to == "elsewhere" {
            std::fs::rename(folder.join("elsewhere"), folder.join("real")).expect("hide it");
            std::fs::create_dir(folder.join("elsewhere")).expect("impostor");
            std::fs::hard_link(folder.join("real/a.md"), folder.join("elsewhere/a.md"))
                .expect("hard link");
        }
    });

    let error = files_io::rename(
        fixture.root(),
        "docs",
        "elsewhere",
        Some(&description.version),
        Some(&own),
    )
    .expect_err("a different folder with the same digest is not the guarded entry");

    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(
        fixture.read("real/a.md"),
        b"a\n",
        "the real folder is untouched"
    );
}

#[test]
fn remove_folder_recursively() {
    let fixture = Fixture::new();
    fixture.write("folder/nested/deep.txt", b"deep\n");
    fixture.write("folder/top.txt", b"top\n");
    fixture.write("sibling.txt", b"sibling\n");

    files_io::remove(fixture.root(), "folder").expect("remove the folder");
    assert!(!fixture.exists("folder"));
    assert!(fixture.dir().exists(), "the root itself stays");
    assert_eq!(fixture.read("sibling.txt"), b"sibling\n");

    files_io::remove(fixture.root(), "sibling.txt").expect("remove a file");
    assert!(!fixture.exists("sibling.txt"));

    let error = files_io::remove(fixture.root(), "sibling.txt").expect_err("already gone");
    assert_eq!(error.code(), "NOT_FOUND");
}

#[test]
fn create_dir_creates_one_folder_and_refuses_a_taken_name() {
    let fixture = Fixture::new();
    let created = files_io::create_dir(fixture.root(), "src").expect("create a folder");
    assert!(fixture.dir().join("src").is_dir());
    assert_eq!(
        created.version.as_deref(),
        Some(fixture.version("src").as_str()),
        "a create reports the digest of the folder it made"
    );
    files_io::create_dir(fixture.root(), "src/nested").expect("create inside it");

    let error = files_io::create_dir(fixture.root(), "src").expect_err("a taken folder");
    assert_eq!(error.code(), "CONFLICT");

    let missing_parent =
        files_io::create_dir(fixture.root(), "absent/child").expect_err("the parent must exist");
    assert_eq!(missing_parent.code(), "NOT_FOUND");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_create_reports_the_folder_it_made_not_the_name_it_published() {
    use files_io::test_hooks::{Step, watch};

    let fixture = Fixture::new();
    let folder = fixture.dir().to_path_buf();
    // After the folder is published, another program takes the name for a file of its own. The
    // reply must describe the folder this create made, never the impostor.
    let _hook = watch(move |step, from, _to| {
        if step == Step::AfterCreateDir && from == "made" {
            std::fs::rename(folder.join("made"), folder.join("elsewhere")).expect("move away");
            std::fs::write(folder.join("made"), b"not the folder\n").expect("impostor");
        }
    });

    let created = files_io::create_dir(fixture.root(), "made").expect("create a folder");

    #[cfg(unix)]
    {
        // Unix keeps the created folder's handle through publication, so it still knows the
        // folder's digest even though the name now holds another entry.
        let reported = created.version.expect("the created folder's digest");
        assert!(reported.starts_with("tree:"), "{reported}");
        assert_ne!(
            reported,
            fixture.version("made"),
            "the impostor's digest is never the create's reply"
        );
        assert!(fixture.dir().join("elsewhere").is_dir());
    }
    #[cfg(windows)]
    {
        // Windows cannot rename a folder while its handle is open, so a name that no longer holds
        // the created folder has no version to report.
        assert!(created.version.is_none(), "{created:?}");
    }
}

#[test]
fn a_move_reports_the_version_of_the_file_it_moved() {
    let fixture = Fixture::new();
    fixture.write("a.md", b"moved bytes\n");

    let moved = files_io::rename(fixture.root(), "a.md", "b.md", None, None).expect("move");

    assert_eq!(
        moved.version.as_deref(),
        Some(fixture.version("b.md").as_str()),
        "the reply is the moved file's version"
    );
    assert!(moved.identity.is_none(), "a file has no separate identity");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_move_never_reports_the_version_of_a_name_it_no_longer_holds() {
    use files_io::test_hooks::{Step, watch};

    let fixture = Fixture::new();
    fixture.write("race-a.md", b"moved bytes\n");
    let folder = fixture.dir().to_path_buf();
    // A program replaces the destination right after the move. The reply must not describe that
    // program's file as if it were the entry the move carried.
    let _hook = watch(move |step, from, to| {
        if step == Step::AfterMove && from == "race-a.md" && to == "race-b.md" {
            std::fs::write(folder.join(".intruder"), b"someone else's file\n").expect("intruder");
            std::fs::rename(folder.join(".intruder"), folder.join("race-b.md")).expect("replace");
        }
    });

    let moved =
        files_io::rename(fixture.root(), "race-a.md", "race-b.md", None, None).expect("move");

    assert!(
        moved.version.is_none(),
        "a destination that is not the moved entry has no version: {moved:?}"
    );
    assert_eq!(fixture.read("race-b.md"), b"someone else's file\n");
}

#[test]
fn a_moved_folder_reports_its_own_version_as_the_identity_a_later_digest_must_match() {
    let fixture = Fixture::new();
    fixture.write("before/deep.md", b"deep\n");
    let before = files_io::describe_entry(fixture.root(), "before").expect("describe the folder");

    let moved = files_io::rename(fixture.root(), "before", "after", None, None).expect("move");

    assert!(
        moved.version.is_none(),
        "a folder's digest records its path, so the caller takes it after the queue"
    );
    let identity = moved
        .identity
        .expect("a moved folder reports its own version");
    assert_eq!(
        identity.rsplit_once(':').map(|(rest, _)| rest),
        before.version.rsplit_once(':').map(|(rest, _)| rest),
        "only the change time moved"
    );
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_trash_whose_rollback_fails_reports_the_endpoint_it_is_preserved_at() {
    use files_io::test_hooks::{Step, watch};

    let fixture = Fixture::new();
    fixture.write("gone.md", b"the original\n");
    let version = fixture.version("gone.md");
    let folder = fixture.dir().to_path_buf();
    // The entry moves to the endpoint; the guard then fails (the entry changed) and the original
    // path is taken by another program, so it cannot be put back.
    let _hook = watch(move |step, from, to| {
        if step == Step::AfterMove && from == "gone.md" && to == ".ace-upload-trash-strand" {
            std::fs::write(folder.join("gone.md"), b"someone else's file\n").expect("squatter");
            std::fs::write(folder.join(".ace-upload-trash-strand"), b"changed\n").expect("change");
        }
    });

    let error = files_io::trash(
        fixture.root(),
        "gone.md",
        ".ace-upload-trash-strand",
        &version,
        None,
    )
    .expect_err("a delete that could not be put back is not a plain success");

    assert_eq!(error.code(), "STRANDED");
    assert_eq!(
        error.recovery().as_deref(),
        Some(".ace-upload-trash-strand"),
        "the outcome carries the recovery id"
    );
    assert_eq!(
        fixture.read(".ace-upload-trash-strand"),
        b"changed\n",
        "the moved entry is preserved at the endpoint"
    );
    assert_eq!(
        fixture.read("gone.md"),
        b"someone else's file\n",
        "the name that appeared is never replaced"
    );
}

#[test]
fn a_journaled_staging_entry_is_finished_at_a_client_path_without_replacing_one() {
    let fixture = Fixture::new();
    fixture.write(".ace-upload-move-journal1", b"the parked entry\n");
    fixture.write("taken.md", b"taken\n");

    let error = files_io::recover_move(fixture.root(), ".ace-upload-move-journal1", "taken.md")
        .expect_err("a taken destination is never replaced");
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("taken.md"), b"taken\n");
    assert_eq!(
        fixture.read(".ace-upload-move-journal1"),
        b"the parked entry\n"
    );

    files_io::recover_move(fixture.root(), ".ace-upload-move-journal1", "finished.md")
        .expect("the journaled move finishes");
    assert_eq!(fixture.read("finished.md"), b"the parked entry\n");
    assert!(!fixture.exists(".ace-upload-move-journal1"));
}

#[test]
fn a_recovery_only_moves_the_daemons_own_staging_names() {
    let fixture = Fixture::new();
    fixture.write("ordinary.md", b"a client's file\n");

    let error = files_io::recover_move(fixture.root(), "ordinary.md", "elsewhere.md")
        .expect_err("a client path is not a staging name");
    assert_eq!(error.code(), "INVALID_ARGUMENT");
    assert_eq!(fixture.read("ordinary.md"), b"a client's file\n");
}

#[cfg(unix)]
#[test]
fn remove_refuses_a_link_and_never_touches_its_target() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().expect("outside dir");
    let target = outside.path().join("target.txt");
    std::fs::write(&target, b"keep me\n").expect("outside file");
    std::os::unix::fs::symlink(&target, fixture.path("link.txt")).expect("symlink");

    let error = files_io::remove(fixture.root(), "link.txt").expect_err("a link is not a target");

    assert_eq!(error.code(), "PATH_ESCAPE");
    assert!(fixture.exists("link.txt"));
    assert_eq!(std::fs::read(&target).expect("read outside"), b"keep me\n");
}

#[cfg(unix)]
#[test]
fn remove_folder_keeps_what_its_links_point_at_outside_the_root() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().expect("outside dir");
    let target = outside.path().join("secret.txt");
    std::fs::write(&target, b"not ours\n").expect("outside file");
    fixture.write("folder/inside.txt", b"inside\n");
    std::os::unix::fs::symlink(outside.path(), fixture.path("folder/link")).expect("symlink");

    files_io::remove(fixture.root(), "folder").expect("remove the folder");

    assert!(!fixture.exists("folder"));
    assert_eq!(
        std::fs::read(&target).expect("the outside file survives"),
        b"not ours\n"
    );
}

#[test]
fn trash_and_untrash_round_trip_a_folder_with_its_digest() {
    let fixture = Fixture::new();
    fixture.write("docs/nested/deep.txt", b"deep\n");
    let description = files_io::describe(fixture.root(), "docs", &files_io::Walks::unbounded())
        .expect("describe the folder");
    let own = description.own_version.clone().expect("an own version");

    files_io::trash(
        fixture.root(),
        "docs",
        ".ace-upload-trash-7",
        &description.version,
        Some(&own),
    )
    .expect("trash a verified folder");
    assert!(!fixture.exists("docs"));
    assert_eq!(
        fixture.read(".ace-upload-trash-7/nested/deep.txt"),
        b"deep\n"
    );

    files_io::untrash(fixture.root(), ".ace-upload-trash-7", "docs").expect("restore it");
    assert_eq!(fixture.read("docs/nested/deep.txt"), b"deep\n");

    let error = files_io::untrash(fixture.root(), ".ace-upload-trash-7", "docs")
        .expect_err("the endpoint is gone");
    assert_eq!(error.code(), "NOT_FOUND");
}

#[test]
fn a_restore_reports_the_version_of_the_entry_it_moved() {
    let fixture = Fixture::new();
    fixture.write(".ace-upload-trash-9", b"restored bytes\n");
    let trashed = files_io::stat_version(fixture.root(), ".ace-upload-trash-9")
        .expect("stat the endpoint")
        .expect("a version");

    let restored = files_io::untrash(fixture.root(), ".ace-upload-trash-9", "restored.md")
        .expect("restore it");

    let version = restored
        .version
        .expect("a file's restore reports its version");
    // The version is read through the entry the restore moved, and it is the version the name
    // now holds.
    assert_eq!(
        files_io::stat_version(fixture.root(), "restored.md")
            .expect("stat")
            .expect("a version"),
        version
    );
    assert!(
        !trashed.is_empty(),
        "the endpoint's version was read before the move"
    );
}

#[test]
fn a_restore_of_a_folder_reports_no_version() {
    let fixture = Fixture::new();
    fixture.write(".ace-upload-trash-8/a.md", b"a\n");

    let restored =
        files_io::untrash(fixture.root(), ".ace-upload-trash-8", "kept").expect("restore it");

    // A folder's digest records the path it is read at, so a restore of one never reports a
    // version the caller could mistake for the folder it moved.
    assert_eq!(restored.version, None);
    assert!(fixture.exists("kept/a.md"));
}

#[test]
fn a_trash_never_takes_a_client_path_the_policy_protects() {
    let fixture = Fixture::new();
    fixture.write(".git/config", b"[core]\n");
    fixture.write(".ace-upload-1", b"private\n");

    for (path, code) in [
        (".git/config", "INVALID_PATH"),
        (".ace-upload-1", "INVALID_PATH"),
    ] {
        let error = files_io::trash(
            fixture.root(),
            path,
            ".ace-upload-trash-8",
            "0:0:0:0:0",
            None,
        )
        .expect_err("a reserved client path is never trashed");
        assert_eq!(error.code(), code, "{path}");
    }
    assert_eq!(fixture.read(".git/config"), b"[core]\n");
}

#[test]
fn a_move_of_a_verified_folder_is_checked_after_it_lands() {
    let fixture = Fixture::new();
    fixture.write("before/nested/deep.txt", b"deep\n");
    let description = files_io::describe(fixture.root(), "before", &files_io::Walks::unbounded())
        .expect("describe");
    let own = description.own_version.clone().expect("own");

    files_io::rename(
        fixture.root(),
        "before",
        "after",
        Some(&description.version),
        Some(&own),
    )
    .expect("the unchanged tree moves");
    assert_eq!(fixture.read("after/nested/deep.txt"), b"deep\n");

    let error = files_io::rename(
        fixture.root(),
        "after",
        "elsewhere",
        Some(&description.version),
        Some(&own),
    )
    .expect_err("the digest was taken under the old name");
    // The folder's version records the path its entries answer to, so the digest from `before`
    // no longer guards a move of `after`; the folder is moved back untouched.
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("after/nested/deep.txt"), b"deep\n");
}
