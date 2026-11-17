// SPDX-License-Identifier: Apache-2.0

mod common;

use common::Fixture;

#[test]
fn rename_refuses_to_overwrite() {
    let fixture = Fixture::new();
    fixture.write("a.txt", b"a\n");
    fixture.write("b.txt", b"b\n");

    let error = files_io::rename(fixture.root(), "a.txt", "b.txt", false)
        .expect_err("an existing destination must be refused");
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(fixture.read("a.txt"), b"a\n");
    assert_eq!(fixture.read("b.txt"), b"b\n");

    files_io::rename(fixture.root(), "a.txt", "b.txt", true).expect("an allowed overwrite");
    assert!(!fixture.exists("a.txt"));
    assert_eq!(fixture.read("b.txt"), b"a\n");

    files_io::rename(fixture.root(), "b.txt", "c.txt", false).expect("rename to a free name");
    assert!(!fixture.exists("b.txt"));
    assert_eq!(fixture.read("c.txt"), b"a\n");
}

#[test]
fn rename_moves_a_folder_with_its_contents() {
    let fixture = Fixture::new();
    fixture.write("before/nested/deep.txt", b"deep\n");
    files_io::rename(fixture.root(), "before", "after", false).expect("rename the folder");
    assert!(!fixture.exists("before"));
    assert_eq!(fixture.read("after/nested/deep.txt"), b"deep\n");
}

#[test]
fn rename_of_a_missing_file_is_not_found() {
    let fixture = Fixture::new();
    let error = files_io::rename(fixture.root(), "missing.txt", "other.txt", false)
        .expect_err("nothing to move");
    assert_eq!(error.code(), "NOT_FOUND");
}

#[test]
fn rename_moves_between_folders_and_replaces_only_when_asked() {
    let fixture = Fixture::new();
    fixture.write("a/one.txt", b"one\n");
    fixture.write("b/two.txt", b"two\n");

    files_io::rename(fixture.root(), "a/one.txt", "b/three.txt", false).expect("move into b");
    assert!(!fixture.exists("a/one.txt"));
    assert_eq!(fixture.read("b/three.txt"), b"one\n");

    let error = files_io::rename(fixture.root(), "b/three.txt", "b/two.txt", false)
        .expect_err("b/two.txt exists");
    assert_eq!(error.code(), "CONFLICT");

    files_io::rename(fixture.root(), "b/three.txt", "b/two.txt", true).expect("replace");
    assert_eq!(fixture.read("b/two.txt"), b"one\n");
    assert!(!fixture.exists("b/three.txt"));
}

#[test]
fn rename_into_its_own_subfolder_is_invalid() {
    let fixture = Fixture::new();
    fixture.write("dir/inside.txt", b"inside\n");

    let error = files_io::rename(fixture.root(), "dir", "dir/moved", false)
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

    files_io::rename(fixture.root(), "Notes.md", "notes.md", false).expect("a case-only rename");

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
    files_io::create_dir(fixture.root(), "src").expect("create a folder");
    assert!(fixture.dir().join("src").is_dir());
    files_io::create_dir(fixture.root(), "src/nested").expect("create inside it");

    let error = files_io::create_dir(fixture.root(), "src").expect_err("a taken folder");
    assert_eq!(error.code(), "CONFLICT");

    let missing_parent =
        files_io::create_dir(fixture.root(), "absent/child").expect_err("the parent must exist");
    assert_eq!(missing_parent.code(), "NOT_FOUND");
}

#[cfg(unix)]
#[test]
fn remove_deletes_a_symlink_not_its_target() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().expect("outside dir");
    let target = outside.path().join("target.txt");
    std::fs::write(&target, b"keep me\n").expect("outside file");
    std::os::unix::fs::symlink(&target, fixture.path("link.txt")).expect("symlink");

    files_io::remove(fixture.root(), "link.txt").expect("remove the link");

    assert!(!fixture.exists("link.txt"));
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
