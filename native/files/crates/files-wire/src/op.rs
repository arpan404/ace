// SPDX-License-Identifier: Apache-2.0

//! What a `request` asks `ace-files` to do.

use serde::{Deserialize, Serialize};

use crate::files::SearchQuery;

/// One request. `root` is the number `openRoot` handed out, not a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    /// Open a checkout root. The result is its number.
    OpenRoot {
        /// Absolute path of the checkout to open.
        path: String,
    },
    /// Forget a root, closing every subscription on it.
    CloseRoot {
        /// The root's number.
        root: u64,
    },
    /// List one folder, one level deep.
    List {
        /// The root's number.
        root: u64,
        /// Root-relative folder; the empty string is the root itself.
        dir: String,
        /// How many entries to return, 1 to 5000.
        limit: u64,
        /// The cursor of the previous page, absent for the first page.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        /// Glob patterns that are never listed, such as `.git`.
        hide: Vec<String>,
    },
    /// Describe one path.
    Stat {
        /// The root's number.
        root: u64,
        /// Root-relative path.
        path: String,
    },
    /// Read bytes of a file. The result carries metadata and a body frame carries the bytes.
    Read {
        /// The root's number.
        root: u64,
        /// Root-relative path.
        path: String,
        /// Byte offset to start at.
        offset: u64,
        /// How many bytes to return.
        length: u64,
        /// Return no bytes at all when the file is larger than this.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_size: Option<u64>,
    },
    /// Replace a file's bytes with the body frame's bytes. The result is the new version.
    Write {
        /// The root's number.
        root: u64,
        /// Root-relative path.
        path: String,
        /// The version the writer last saw; a different current version is `CONFLICT`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected: Option<String>,
    },
    /// Create a file from the body frame's bytes. The result is its version.
    CreateFile {
        /// The root's number.
        root: u64,
        /// Root-relative path of the new file.
        path: String,
    },
    /// Create a folder.
    CreateDir {
        /// The root's number.
        root: u64,
        /// Root-relative path of the new folder.
        path: String,
    },
    /// Move or rename a path.
    Rename {
        /// The root's number.
        root: u64,
        /// Root-relative path to move.
        from: String,
        /// Root-relative destination.
        to: String,
        /// True to replace an existing destination.
        overwrite: bool,
    },
    /// Delete a file or a folder and everything inside it.
    Remove {
        /// The root's number.
        root: u64,
        /// Root-relative path to delete.
        path: String,
    },
    /// Start watching a root. The result is the subscription; `event` messages follow.
    Watch {
        /// The root's number.
        root: u64,
    },
    /// Stop a watch or search subscription.
    Unwatch {
        /// The subscription to close.
        subscription: u64,
    },
    /// Search the quick-open index.
    IndexQuery {
        /// The root's number.
        root: u64,
        /// The typed query; empty finds nothing.
        query: String,
        /// At most this many hits.
        limit: u64,
    },
    /// Search file contents. The result is a subscription; `event` messages report matches.
    Search {
        /// The root's number.
        root: u64,
        /// What to look for and how.
        #[serde(flatten)]
        query: SearchQuery,
    },
}
