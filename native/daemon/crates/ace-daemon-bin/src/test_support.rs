// SPDX-License-Identifier: Apache-2.0
//! Test-only helpers: a fresh directory under the system temporary directory,
//! never `~/.ace`, and its removal.

use std::path::{Path, PathBuf};

/// A directory that exists only for one test.
pub struct TempDir(PathBuf);

impl TempDir {
    /// Make a fresh directory whose name starts with `prefix`.
    pub fn new(prefix: &str) -> Self {
        let nonce = crate::ids::random_hex_32().unwrap_or_else(|_| "0".repeat(64));
        let path = std::env::temp_dir().join(format!("{prefix}-{}", &nonce[..12]));
        let _ = std::fs::create_dir_all(&path);
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
