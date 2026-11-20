// SPDX-License-Identifier: Apache-2.0

//! `Root::is_at`: the proof a walker takes between opening a file and reading it.

// Tests fail loudly on a broken fixture; the workspace rule against panicking is about library code.
#![allow(clippy::expect_used)]
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;

use files_safe::Root;
use tempfile::TempDir;

/// A checkout holding `a/d/one.txt`, that file open, and a folder outside the checkout.
fn opened() -> (
    TempDir,
    TempDir,
    Root,
    cap_std::fs::File,
    cap_std::fs::Metadata,
) {
    let checkout = tempfile::tempdir().expect("temp dir");
    let outside = tempfile::tempdir().expect("another temp dir");
    fs::create_dir_all(checkout.path().join("a/d")).expect("folders");
    fs::write(checkout.path().join("a/d/one.txt"), "inside").expect("file");
    let root = Root::open(checkout.path()).expect("open root");
    let file = root
        .open_dir("a/d")
        .expect("the folder")
        .open("one.txt")
        .expect("the file");
    let metadata = file.metadata().expect("its metadata");
    (checkout, outside, root, file, metadata)
}

#[test]
fn an_open_file_still_at_its_path_is_there() {
    let (_checkout, _outside, root, file, metadata) = opened();
    assert!(root.is_at("a/d/one.txt", &file, &metadata));
    assert!(
        !root.is_at("a/d", &file, &metadata),
        "another entry is not the file"
    );
}

#[test]
fn a_file_whose_ancestor_moved_out_is_not_there() {
    let (checkout, outside, root, file, metadata) = opened();
    fs::rename(checkout.path().join("a"), outside.path().join("a")).expect("the move");
    assert!(!root.is_at("a/d/one.txt", &file, &metadata));
}

#[test]
fn a_file_reached_through_an_ancestor_link_out_is_not_there() {
    let (checkout, outside, root, file, metadata) = opened();
    fs::rename(checkout.path().join("a"), outside.path().join("a")).expect("the move");
    symlink(outside.path().join("a"), checkout.path().join("a")).expect("a link out");
    assert!(!root.is_at("a/d/one.txt", &file, &metadata));
}

#[test]
fn a_file_reached_through_any_link_is_not_there_even_inside_the_root() {
    let (checkout, _outside, root, file, metadata) = opened();
    fs::rename(checkout.path().join("a"), checkout.path().join("b")).expect("the move");
    symlink("b", checkout.path().join("a")).expect("a link inside");
    assert!(!root.is_at("a/d/one.txt", &file, &metadata));
}

#[test]
fn a_leaf_swapped_for_a_link_to_the_same_file_is_not_there() {
    let (checkout, _outside, root, file, metadata) = opened();
    let leaf = checkout.path().join("a/d/one.txt");
    fs::rename(&leaf, checkout.path().join("a/d/moved.txt")).expect("the move");
    symlink("moved.txt", &leaf).expect("a link takes its name");
    assert!(!root.is_at("a/d/one.txt", &file, &metadata));
}

#[test]
fn nothing_is_there_once_the_root_path_names_another_folder() {
    let (checkout, outside, root, file, metadata) = opened();
    let path = root.path().to_path_buf();
    // The tree the handle holds moves away, so the file is still reachable through the handle, and
    // another folder takes the root's name.
    fs::rename(&path, outside.path().join("moved")).expect("the root moves");
    fs::create_dir_all(path.join("a/d")).expect("another folder takes its name");
    assert!(!root.is_at("a/d/one.txt", &file, &metadata));
    drop(checkout);
}
