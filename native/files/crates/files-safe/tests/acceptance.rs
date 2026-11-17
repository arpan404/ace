// SPDX-License-Identifier: Apache-2.0

//! The confinement behaviour the rest of ace-files is written against, on real folders.

// Tests fail loudly on a broken fixture; the workspace rule against panicking is about library code.
#![allow(clippy::expect_used)]

use std::fs;

use files_safe::Root;
use tempfile::TempDir;

fn checkout() -> (TempDir, Root) {
    let temp = tempfile::tempdir().expect("temp dir");
    let root = Root::open(temp.path()).expect("open root");
    (temp, root)
}

#[test]
fn rejects_dot_dot_and_absolute_paths() {
    let (_temp, root) = checkout();

    for rel in [
        "..",
        "../outside",
        "a/../../outside",
        "a/../..",
        "/",
        "/etc/passwd",
        "/a",
    ] {
        assert_eq!(
            Root::check(rel).expect_err(rel).code(),
            "INVALID_PATH",
            "check {rel}"
        );
        assert_eq!(
            root.resolve(rel).expect_err(rel).code(),
            "INVALID_PATH",
            "resolve {rel}"
        );
    }
}

#[test]
fn rejects_malformed_forms() {
    let (_temp, root) = checkout();
    for rel in ["", "a", "a/b"] {
        assert_eq!(Root::check(rel).expect(rel), rel);
    }
    for rel in ["a/", "a//b", "./a", "a/.", "a\0b", ".", ".."] {
        assert_eq!(
            Root::check(rel).expect_err(rel).code(),
            "INVALID_PATH",
            "{rel}"
        );
    }
    assert_eq!(
        root.resolve("a\0b").expect_err("nul").code(),
        "INVALID_PATH"
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlink_that_leaves_root() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp dir");
    let checkout = temp.path().join("checkout");
    let outside = temp.path().join("outside");
    let sibling = temp.path().join("checkout-copy");
    fs::create_dir_all(checkout.join("sub")).expect("folders");
    fs::create_dir_all(&outside).expect("outside");
    fs::create_dir_all(&sibling).expect("sibling");
    fs::write(outside.join("secret.txt"), b"secret").expect("outside file");

    let root = Root::open(&checkout).expect("open root");
    let outside = fs::canonicalize(&outside).expect("canonical outside");
    let sibling = fs::canonicalize(&sibling).expect("canonical sibling");

    symlink(&outside, root.path().join("absolute")).expect("absolute link");
    symlink("../../outside", root.path().join("sub").join("relative")).expect("relative link");
    symlink(outside.join("missing.txt"), root.path().join("dangling")).expect("dangling link");
    symlink(&sibling, root.path().join("sibling")).expect("prefix sibling link");

    for rel in [
        "absolute",
        "absolute/secret.txt",
        "sub/relative",
        "sub/relative/secret.txt",
        "sub/relative/missing.txt",
        "dangling",
        "sibling",
        "sibling/file.txt",
    ] {
        assert_eq!(
            root.resolve(rel).expect_err(rel).code(),
            "PATH_ESCAPE",
            "resolve {rel}"
        );
    }
}

#[cfg(unix)]
#[test]
fn follows_symlink_that_stays_inside_root() {
    use std::os::unix::fs::symlink;

    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("real/nested")).expect("folders");
    fs::create_dir_all(root.path().join("other")).expect("folders");
    fs::write(root.path().join("real/file.txt"), b"inside").expect("file");

    symlink("real", root.path().join("link")).expect("relative link");
    symlink(root.path().join("real"), root.path().join("absolute")).expect("absolute link");
    symlink("../real/file.txt", root.path().join("other/file.txt")).expect("file link");

    assert_eq!(
        root.resolve("link").expect("link"),
        root.path().join("real")
    );
    assert_eq!(
        root.resolve("link/nested").expect("nested"),
        root.path().join("real/nested")
    );
    assert_eq!(
        root.resolve("link/file.txt").expect("through link"),
        root.path().join("real/file.txt")
    );
    assert_eq!(
        root.resolve("absolute/nested").expect("absolute link"),
        root.path().join("real/nested")
    );
    assert_eq!(
        root.resolve("other/file.txt")
            .expect("climbing to a sibling"),
        root.path().join("real/file.txt")
    );
}

#[test]
fn resolves_missing_leaf_under_existing_parent() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a/b")).expect("folders");

    assert_eq!(root.resolve("").expect("root"), root.path().to_path_buf());
    assert_eq!(
        root.resolve("new.txt").expect("leaf in the root"),
        root.path().join("new.txt")
    );
    assert_eq!(
        root.resolve("a/b/new.txt").expect("leaf in a folder"),
        root.path().join("a/b/new.txt")
    );
    assert_eq!(
        root.resolve("a/missing/deeper.txt")
            .expect_err("gap")
            .code(),
        "NOT_FOUND"
    );
}

#[test]
fn relative_round_trips_resolve() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a/b")).expect("folders");
    fs::write(root.path().join("a/b/file.txt"), b"x").expect("file");

    for rel in ["", "a", "a/b", "a/b/file.txt", "a/b/missing.txt"] {
        let absolute = root.resolve(rel).expect(rel);
        assert_eq!(root.relative(&absolute).as_deref(), Some(rel), "{rel}");
    }

    let outside = root.path().parent().expect("parent of the root");
    assert_eq!(root.relative(outside), None);
    assert_eq!(root.relative(&root.path().join("a/../b")), None);
}

#[test]
fn root_must_be_a_directory() {
    let temp = tempfile::tempdir().expect("temp dir");
    let file = temp.path().join("file.txt");
    fs::write(&file, b"x").expect("write file");

    assert_eq!(
        Root::open(&file).err().expect("a file").code(),
        "NOT_DIRECTORY"
    );
    assert_eq!(
        Root::open(&temp.path().join("missing"))
            .err()
            .expect("gone")
            .code(),
        "NOT_FOUND"
    );

    let root = Root::open(temp.path()).expect("open root");
    assert!(root.path().is_absolute());
    assert_eq!(
        root.path(),
        fs::canonicalize(temp.path()).expect("canonical")
    );
    fs::write(root.path().join("probe.txt"), b"x").expect("write");
    let via_handle = root
        .dir()
        .metadata("probe.txt")
        .expect("stat through the handle");
    assert!(via_handle.is_file());
}

#[cfg(windows)]
#[test]
fn rejects_windows_only_forms() {
    let (_temp, root) = checkout();
    for rel in [
        r"a\b", r"\a", "C:", "C:/a", "c:temp", "CON", "nul.txt", "aux/x", "com1", "a.", "a ",
        "a./b", "a:stream",
    ] {
        assert_eq!(
            root.resolve(rel).expect_err(rel).code(),
            "INVALID_PATH",
            "resolve {rel}"
        );
    }
}

#[cfg(unix)]
#[test]
fn refuses_a_link_loop_instead_of_spinning() {
    use std::os::unix::fs::symlink;

    let (_temp, root) = checkout();
    symlink("b", root.path().join("a")).expect("a -> b");
    symlink("a", root.path().join("b")).expect("b -> a");
    symlink("self", root.path().join("self")).expect("self -> self");

    assert_eq!(root.resolve("a").expect_err("loop").code(), "IO_ERROR");
    assert_eq!(
        root.resolve("self/file.txt").expect_err("loop").code(),
        "IO_ERROR"
    );
    assert_eq!(
        root.resolve("a/file.txt").expect_err("loop").code(),
        "IO_ERROR"
    );
}

#[test]
fn refuses_a_file_where_a_folder_is_needed() {
    let (_temp, root) = checkout();
    fs::write(root.path().join("file.txt"), b"x").expect("write");

    assert_eq!(
        root.resolve("file.txt/inner").expect_err("file").code(),
        "NOT_DIRECTORY"
    );
    assert_eq!(
        root.resolve("file.txt").expect("the file itself"),
        root.path().join("file.txt")
    );
}

#[cfg(not(windows))]
#[test]
fn keeps_names_windows_would_refuse() {
    let (_temp, root) = checkout();
    for rel in ["con", "aux.txt", "a.", "a b", "a\\b"] {
        assert_eq!(
            root.resolve(rel).expect(rel),
            root.path().join(rel),
            "{rel}"
        );
    }
}
