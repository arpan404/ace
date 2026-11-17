// SPDX-License-Identifier: Apache-2.0

//! The handle API: what ace-files opens through, so a rename cannot redirect an operation.

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
fn opens_a_folder_through_a_handle() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a/b")).expect("folders");
    fs::write(root.path().join("a/b/file.txt"), b"x").expect("file");

    let folder = root.open_dir("a/b").expect("open a/b");
    let found = folder
        .metadata("file.txt")
        .expect("stat through the handle");
    assert!(found.is_file());

    let root_handle = root.open_dir("").expect("open the root");
    assert!(root_handle.symlink_metadata("a").is_ok());
}

#[test]
fn opening_a_file_as_a_folder_is_not_a_directory() {
    let (_temp, root) = checkout();
    fs::write(root.path().join("file.txt"), b"x").expect("file");

    assert_eq!(
        root.open_dir("file.txt").expect_err("a file").code(),
        "NOT_DIRECTORY"
    );
    assert_eq!(
        root.open_dir("missing").expect_err("missing").code(),
        "NOT_FOUND"
    );
}

#[cfg(unix)]
#[test]
fn opening_a_folder_through_a_link_stays_inside() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp dir");
    let checkout = temp.path().join("checkout");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&checkout).expect("folders");
    fs::create_dir_all(&outside).expect("folders");

    let root = Root::open(&checkout).expect("open root");
    let outside = fs::canonicalize(&outside).expect("canonical outside");

    symlink("real", root.path().join("link")).expect("link");
    fs::create_dir_all(root.path().join("real")).expect("folders");
    symlink(&outside, root.path().join("outlink")).expect("outside link");

    assert!(root.open_dir("link").is_ok());
    assert_eq!(
        root.open_dir("outlink").expect_err("escape").code(),
        "PATH_ESCAPE"
    );
}

#[test]
fn open_parent_returns_the_folder_and_the_leaf_name() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a")).expect("folders");

    let (parent, leaf) = root.open_parent("a/new.txt").expect("open parent");
    assert_eq!(leaf, "new.txt");
    parent.create("new.txt").expect("create through the parent");
    assert!(root.path().join("a/new.txt").is_file());

    let (root_folder, leaf) = root
        .open_parent("top.txt")
        .expect("open the root as parent");
    assert_eq!(leaf, "top.txt");
    root_folder.create("top.txt").expect("create in the root");
    assert!(root.path().join("top.txt").is_file());
}

#[test]
fn open_parent_names_the_leaf_the_folder_stores() {
    let (_temp, root) = checkout();
    fs::write(root.path().join("Stored.TXT"), b"x").expect("file");

    let (parent, leaf) = root.open_parent("Stored.TXT").expect("open parent");
    assert_eq!(leaf, "Stored.TXT");
    assert!(parent.symlink_metadata(&leaf).is_ok());
}

#[cfg(unix)]
#[test]
fn open_parent_never_follows_the_leaf() {
    use std::os::unix::fs::symlink;

    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a")).expect("folders");
    symlink("missing.txt", root.path().join("a/dangling")).expect("dangling link");

    let (parent, leaf) = root.open_parent("a/dangling").expect("open parent");
    assert_eq!(leaf, "dangling", "a dangling link is a name, not a target");
    let found = parent
        .symlink_metadata("dangling")
        .expect("the link itself");
    assert!(found.file_type().is_symlink());
    assert!(parent.symlink_metadata("missing.txt").is_err());
}

#[test]
fn open_parent_refuses_the_root() {
    let (_temp, root) = checkout();
    assert_eq!(
        root.open_parent("").expect_err("no parent").code(),
        "INVALID_PATH"
    );
}

#[test]
fn relative_only_returns_the_accepted_form() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join("a b")).expect("folders");
    fs::write(root.path().join("a b/file.txt"), b"x").expect("file");

    for rel in ["", "a b", "a b/file.txt"] {
        let relative = root.relative(&root.resolve(rel).expect(rel)).expect(rel);
        assert_eq!(relative, rel);
        assert_eq!(Root::check(&relative).expect("check accepts it"), relative);
    }

    assert_eq!(root.relative(&root.path().join("a b/../a b")), None);
}

#[cfg(unix)]
#[test]
fn relative_is_none_for_a_name_the_platform_refuses() {
    let (_temp, root) = checkout();
    let absolute = root.path().join("a b");
    assert_eq!(root.relative(&absolute).as_deref(), Some("a b"));
    // Unchecked segments such as `..` or a NUL never come back as a relative path.
    assert_eq!(root.relative(&root.path().join("a\0b")), None);
}

#[test]
fn returns_the_name_the_folder_stores() {
    let (_temp, root) = checkout();
    fs::create_dir_all(root.path().join(".git")).expect("folders");
    fs::write(root.path().join(".git/config"), b"x").expect("file");

    match root.resolve(".GIT/CONFIG") {
        // A case-insensitive volume finds the entry and the answer carries its stored spelling,
        // which is what `.git` policies must see.
        Ok(path) => assert_eq!(path, root.path().join(".git/config")),
        Err(error) => assert_eq!(
            error.code(),
            "NOT_FOUND",
            "a case-sensitive volume has no .GIT"
        ),
    }
}
