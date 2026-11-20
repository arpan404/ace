// SPDX-License-Identifier: Apache-2.0
#![allow(dead_code)]

//! Shared setup: a real temp checkout and an index built from it.

use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use files_index::{Hit, IndexOptions, PathIndex};
use files_safe::Root;
use tempfile::TempDir;

/// A temp checkout that stays alive as long as the fixture, with an index of it.
pub struct Fixture {
    pub dir: TempDir,
    pub root: Root,
    pub index: PathIndex,
}

/// Create a checkout holding `files` (empty), then build a default index over it.
pub fn indexed(files: &[&str]) -> Fixture {
    let (dir, root) = checkout(files);
    let index = build_index(&root, &IndexOptions::default());
    Fixture { dir, root, index }
}

/// Create a checkout holding `files` (empty) without indexing it.
pub fn checkout(files: &[&str]) -> (TempDir, Root) {
    let dir = tempfile::tempdir().expect("a temp dir");
    for path in files {
        write(dir.path(), path, "");
    }
    let root = Root::open(dir.path()).expect("a checkout root");
    (dir, root)
}

pub fn write(base: &Path, path: &str, contents: &str) {
    let full = base.join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).expect("parent folders");
    }
    fs::write(full, contents).expect("write file");
}

pub fn build_index(root: &Root, options: &IndexOptions) -> PathIndex {
    PathIndex::build(root, options, &AtomicBool::new(false)).expect("built index")
}

pub fn paths(hits: &[Hit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.path.as_str()).collect()
}
