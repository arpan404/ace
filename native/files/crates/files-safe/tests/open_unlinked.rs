// SPDX-License-Identifier: Apache-2.0

//! `Root::open_file_unlinked`: a file opened for reading by its checkout path, resolved from the
//! root in one call with no link followed and nothing outside the root reached.

// Tests fail loudly on a broken fixture; the workspace rule against panicking is about library code.
#![allow(clippy::expect_used)]
#![cfg(any(target_os = "linux", target_os = "android"))]

use std::fs;
use std::io::Read;
use std::os::unix::fs::symlink;

use files_safe::Root;
use tempfile::TempDir;

/// A checkout holding `a/d/one.txt`, and a folder outside it holding `secret.txt`.
fn checkout() -> (TempDir, TempDir, Root) {
    let checkout = tempfile::tempdir().expect("temp dir");
    let outside = tempfile::tempdir().expect("another temp dir");
    fs::create_dir_all(checkout.path().join("a/d")).expect("folders");
    fs::write(checkout.path().join("a/d/one.txt"), "inside").expect("file");
    fs::write(outside.path().join("secret.txt"), "outside").expect("file");
    let root = Root::open(checkout.path()).expect("open root");
    (checkout, outside, root)
}

/// What opening `rel` reads, or `None` when it was refused. A kernel without the call fails the
/// test: every Linux this runs on has `openat2`.
fn read(root: &Root, rel: &str) -> Option<String> {
    let opened = root
        .open_file_unlinked(rel)
        .expect("this kernel resolves a path beneath a folder in one call");
    let mut file = opened.ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).expect("a readable file");
    Some(text)
}

#[test]
fn a_file_at_its_path_is_opened() {
    let (_checkout, _outside, root) = checkout();
    assert_eq!(read(&root, "a/d/one.txt").as_deref(), Some("inside"));
}

#[test]
fn a_file_whose_folder_moved_out_is_not_opened() {
    let (checkout, outside, root) = checkout();
    fs::rename(checkout.path().join("a"), outside.path().join("a")).expect("the move");
    assert_eq!(read(&root, "a/d/one.txt"), None);
}

#[test]
fn a_file_behind_a_folder_link_out_is_not_opened() {
    let (checkout, outside, root) = checkout();
    fs::rename(checkout.path().join("a"), outside.path().join("a")).expect("the move");
    symlink(outside.path().join("a"), checkout.path().join("a")).expect("a link out");
    assert_eq!(read(&root, "a/d/one.txt"), None);
}

#[test]
fn a_file_behind_any_link_is_not_opened_even_inside_the_root() {
    let (checkout, _outside, root) = checkout();
    symlink("a", checkout.path().join("b")).expect("a link inside");
    assert_eq!(read(&root, "b/d/one.txt"), None);
}

#[test]
fn a_leaf_that_is_a_link_is_not_opened() {
    let (checkout, outside, root) = checkout();
    symlink(
        outside.path().join("secret.txt"),
        checkout.path().join("a/d/two.txt"),
    )
    .expect("a link out");
    symlink("one.txt", checkout.path().join("a/d/three.txt")).expect("a link inside");
    assert_eq!(read(&root, "a/d/two.txt"), None);
    assert_eq!(read(&root, "a/d/three.txt"), None);
}

#[test]
fn nothing_is_opened_once_the_root_path_names_another_folder() {
    let (checkout, outside, root) = checkout();
    fs::create_dir_all(outside.path().join("a/d")).expect("folders");
    fs::write(outside.path().join("a/d/one.txt"), "theirs").expect("file");
    let moved = checkout.path().with_extension("old");
    fs::rename(checkout.path(), &moved).expect("move the root");
    symlink(outside.path(), checkout.path()).expect("a link where the root was");
    let refused = read(&root, "a/d/one.txt");
    // Put the checkout back so the temp dir cleans up.
    fs::remove_file(checkout.path()).expect("the link goes");
    fs::rename(&moved, checkout.path()).expect("the root comes back");
    assert_eq!(refused, None);
}

#[test]
fn a_path_that_climbs_out_is_refused() {
    let (_checkout, _outside, root) = checkout();
    assert!(
        root.open_file_unlinked("../secret.txt")
            .is_none_or(|opened| opened.is_err()),
        "a path with `..` is never opened"
    );
}
