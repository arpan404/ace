// SPDX-License-Identifier: Apache-2.0

//! A temp root and the file helpers the files-io behaviour tests share.

#![allow(dead_code)]
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use files_safe::Root;

pub struct Fixture {
    dir: tempfile::TempDir,
    root: Root,
}

impl Fixture {
    pub fn new() -> Fixture {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = Root::open(dir.path()).expect("open root");
        Fixture { dir, root }
    }

    pub fn root(&self) -> &Root {
        &self.root
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.dir.path().join(relative)
    }

    pub fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&path, bytes).expect("write fixture file");
    }

    pub fn read(&self, relative: &str) -> Vec<u8> {
        std::fs::read(self.path(relative)).expect("read fixture file")
    }

    pub fn exists(&self, relative: &str) -> bool {
        self.path(relative).exists()
    }

    /// Sets the modification time so the version has a precise fraction to print.
    pub fn set_modified(&self, relative: &str, seconds: u64, nanoseconds: u32) {
        let time = UNIX_EPOCH + Duration::new(seconds, nanoseconds);
        let file = std::fs::File::options()
            .write(true)
            .open(self.path(relative))
            .expect("open for mtime");
        file.set_modified(time).expect("set mtime");
    }

    pub fn version(&self, relative: &str) -> String {
        files_io::stat_version(self.root(), relative)
            .expect("stat version")
            .expect("a version")
    }
}
