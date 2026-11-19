// SPDX-License-Identifier: Apache-2.0

//! What a `request` asks `ace-files` to do.

use serde::{Deserialize, Serialize};

use crate::files::SearchQuery;

/// The op tags this build understands, in the order of the variants. Kept beside the enum so the
/// decoder can tell an op a newer daemon sends (`UNSUPPORTED`) from a message that is broken.
pub(crate) const TAGS: &[&str] = &[
    "openRoot",
    "closeRoot",
    "list",
    "stat",
    "describe",
    "describeEntry",
    "measure",
    "read",
    "write",
    "createFile",
    "createDir",
    "rename",
    "remove",
    "trash",
    "untrash",
    "recoverMove",
    "watch",
    "unwatch",
    "indexQuery",
    "search",
];

/// True when this build knows the op tag.
pub(crate) fn knows(tag: &str) -> bool {
    TAGS.contains(&tag)
}

/// Keeps the default `false` off the wire.
fn is_false(value: &bool) -> bool {
    !*value
}

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
        /// Page through one pinned listing instead of a folder's stamp, so a traversal that walks
        /// a whole checkout can page a folder that just changed. Internal callers only.
        #[serde(default, skip_serializing_if = "is_false")]
        snapshot: bool,
    },
    /// Describe one path.
    Stat {
        /// The root's number.
        root: u64,
        /// Root-relative path.
        path: String,
    },
    /// One path's version, size, kind and mode, with the daemon's folder digest for a folder.
    Describe {
        /// The root's number.
        root: u64,
        /// Root-relative path.
        path: String,
        /// Walk the whole tree, with no entry budget, for a guard a mutation will compare.
        #[serde(default, skip_serializing_if = "is_false")]
        full: bool,
    },
    /// The entry itself: its own version, never a folder's tree digest, so a guard is cheap.
    DescribeEntry {
        /// The root's number.
        root: u64,
        /// Root-relative path.
        path: String,
        /// Read one of the daemon's own generated names, for its reconciliation. Internal callers
        /// only: a client path never sets it, and it skips only the reserved-name rule.
        #[serde(default, skip_serializing_if = "is_false")]
        internal: bool,
    },
    /// How many bytes of files a path holds, for the trash quota a delete must respect.
    Measure {
        /// The root's number.
        root: u64,
        /// Root-relative path of a file or a folder.
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
    /// Move or rename a path. A taken destination is never replaced.
    Rename {
        /// The root's number.
        root: u64,
        /// Root-relative path to move.
        from: String,
        /// Root-relative destination.
        to: String,
        /// The version the caller worked from; a moved tree that no longer matches is moved back.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected: Option<String>,
        /// A folder's own version from before the move, so its digest can be verified afterward.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        own: Option<String>,
        /// The staging name a case-only move was journaled under, so a start can finish it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        staging: Option<String>,
    },
    /// Delete a file or a folder and everything inside it.
    ///
    /// This is the daemon's own cleanup, not a client delete: a client's delete is `trash`.
    Remove {
        /// The root's number.
        root: u64,
        /// Root-relative path to delete.
        path: String,
    },
    /// Move a client's entry to the generated trash endpoint at the checkout root.
    Trash {
        /// The root's number.
        root: u64,
        /// Root-relative client path.
        path: String,
        /// The generated `.ace-upload-trash-<id>` endpoint at the root.
        endpoint: String,
        /// The version the client worked from; the moved tree is verified against it.
        expected: String,
        /// A folder's own version from before the move, so its digest can be verified afterward.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        own: Option<String>,
    },
    /// Move a generated trash endpoint back to a client path.
    Untrash {
        /// The root's number.
        root: u64,
        /// The generated `.ace-upload-trash-<id>` endpoint at the root.
        endpoint: String,
        /// Root-relative client destination, which must be absent.
        path: String,
    },
    /// Finish a journaled case-only move: the entry parked at one of the daemon's own staging
    /// names moves to a client path, never replacing one. Internal callers only.
    RecoverMove {
        /// The root's number.
        root: u64,
        /// The generated `.ace-upload-move-<id>` staging name, with the folder that holds it.
        from: String,
        /// Root-relative client destination, which must be absent.
        to: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::Case;

    fn every_op() -> Vec<Op> {
        let query = SearchQuery {
            pattern: String::new(),
            regex: false,
            case: Case::Smart,
            whole_word: false,
            include: Vec::new(),
            exclude: Vec::new(),
            include_ignored: false,
            max_matches: 0,
            max_file_bytes: 0,
        };
        vec![
            Op::OpenRoot {
                path: String::new(),
            },
            Op::CloseRoot { root: 0 },
            Op::List {
                root: 0,
                dir: String::new(),
                limit: 1,
                cursor: None,
                hide: Vec::new(),
                snapshot: false,
            },
            Op::Stat {
                root: 0,
                path: String::new(),
            },
            Op::Describe {
                root: 0,
                path: String::new(),
                full: false,
            },
            Op::DescribeEntry {
                root: 0,
                path: String::new(),
                internal: false,
            },
            Op::Measure {
                root: 0,
                path: String::new(),
            },
            Op::Read {
                root: 0,
                path: String::new(),
                offset: 0,
                length: 0,
                max_size: None,
            },
            Op::Write {
                root: 0,
                path: String::new(),
                expected: None,
            },
            Op::CreateFile {
                root: 0,
                path: String::new(),
            },
            Op::CreateDir {
                root: 0,
                path: String::new(),
            },
            Op::Rename {
                root: 0,
                from: String::new(),
                to: String::new(),
                expected: None,
                own: None,
                staging: None,
            },
            Op::Remove {
                root: 0,
                path: String::new(),
            },
            Op::Trash {
                root: 0,
                path: String::new(),
                endpoint: String::new(),
                expected: String::new(),
                own: None,
            },
            Op::Untrash {
                root: 0,
                endpoint: String::new(),
                path: String::new(),
            },
            Op::RecoverMove {
                root: 0,
                from: String::new(),
                to: String::new(),
            },
            Op::Watch { root: 0 },
            Op::Unwatch { subscription: 0 },
            Op::IndexQuery {
                root: 0,
                query: String::new(),
                limit: 0,
            },
            Op::Search { root: 0, query },
        ]
    }

    #[test]
    fn the_tag_list_matches_the_ops() {
        let mut tags = Vec::new();
        for op in every_op() {
            let value = serde_json::to_value(&op).expect("an op serializes");
            let tag = value
                .get("op")
                .and_then(|tag| tag.as_str())
                .expect("an op tag")
                .to_owned();
            assert!(knows(&tag), "{tag} is missing from TAGS");
            tags.push(tag);
        }
        tags.sort();
        tags.dedup();
        let mut known = TAGS.to_vec();
        known.sort();
        assert_eq!(tags, known, "TAGS lists exactly the ops this build knows");
    }
}
