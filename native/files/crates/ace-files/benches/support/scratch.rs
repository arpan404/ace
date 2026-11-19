// SPDX-License-Identifier: Apache-2.0

//! One run's scratch folder inside the bench tree.
//!
//! The watcher and burst write only here, never into the generated checkout, and only the folder
//! this run created is ever deleted. A fresh name per run means a killed run's leftovers cannot be
//! mistaken for this run's files, and the inventory check ignores `bench/` because it is not part
//! of the checkout's fixture.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A folder under the tree's `bench/`, removed when the run ends (on failure too).
pub struct Scratch {
    tree: PathBuf,
    root: PathBuf,
    /// The folder's tree-relative path, `/` separated.
    relative: String,
}

impl Scratch {
    /// Create a fresh `bench/run-<millis>-<pid>` folder inside `tree`.
    pub fn create(tree: &Path) -> io::Result<Scratch> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let relative = format!("bench/run-{stamp}-{}", std::process::id());
        fs::create_dir_all(tree.join("bench"))?;
        let root = tree.join(&relative);
        // `create_dir`, not `create_dir_all`: the name must be this run's alone.
        fs::create_dir(&root)?;
        Ok(Scratch {
            tree: tree.to_path_buf(),
            root,
            relative,
        })
    }

    /// The scratch folder's tree-relative path.
    pub fn relative(&self) -> &str {
        &self.relative
    }

    /// A tree-relative path inside the scratch folder.
    pub fn relative_path(&self, name: &str) -> String {
        format!("{}/{name}", self.relative)
    }

    /// A path inside the scratch folder.
    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// The path a tree-relative path names.
    pub fn join(&self, relative: &str) -> PathBuf {
        self.tree.join(relative)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Only the folder this run made; nothing above it and nothing outside it.
        let _ = fs::remove_dir_all(&self.root);
    }
}
