// SPDX-License-Identifier: Apache-2.0

//! Values that mirror the public result types of the `files-*` crates, as camelCase JSON.

use serde::{Deserialize, Serialize};

/// What a listed path is, tagged by `type` like every other value on the wire: `{"type":"file"}`,
/// `{"type":"symlink","target":{"type":"directory"}}`.
///
/// A symlink carries the kind of its target when the target resolves inside the root; when it
/// does not, `target` is absent and the client shows an unknown target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Kind {
    /// A regular file.
    File,
    /// A directory.
    Directory,
    /// A symbolic link, with its target's kind when that is known.
    Symlink {
        /// The target's kind; absent when the target leaves the root or is unknown.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<Box<Kind>>,
    },
    /// Something else: a socket, a device, a fifo.
    Other,
}

/// One entry of a listed folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Root-relative path, `/` separated.
    pub path: String,
    /// The last path segment, for display.
    pub name: String,
    /// What the path is.
    pub kind: Kind,
    /// Size in bytes.
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub mtime_ms: i64,
    /// True when git's ignore rules match the path. The UI dims these; they are still listed.
    pub ignored: bool,
}

/// One page of a folder listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// The entries in the folder's order: folders first, then natural, case-insensitive order.
    pub entries: Vec<Entry>,
    /// The cursor for the next page, absent on the last page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// How many entries the folder holds, ahead of paging.
    pub total: u64,
}

/// The metadata of a `read` response; the bytes follow in a body frame when `body` is true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMeta {
    /// Size of the whole file in bytes.
    pub size: u64,
    /// The file's version string, as stored in drafts.
    pub version: String,
    /// True when the first 8 KiB holds a NUL byte.
    pub binary: bool,
    /// The detected encoding, an encoding_rs label such as `UTF-8`.
    pub encoding: String,
    /// True when the file starts with a byte order mark.
    pub bom: bool,
    /// True when the returned range reaches the end of the file.
    pub eof: bool,
    /// True when a body frame with this response's id follows.
    pub body: bool,
}

/// One path's details: what the daemon's `stat` and its guarded writes need in one answer.
///
/// `version` is the daemon's version string: a file's identity and times, or a digest of a
/// folder's whole tree, so a client holding an older one can be told what changed. A folder also
/// names its own version, before the digest, so a guarded write can be re-checked without walking
/// the tree again; when a walk stops at its budget `shallow` says the digest was not taken and
/// `version` is that own version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    /// The version string, in the format stored drafts carry.
    pub version: String,
    /// A folder's own version, the entry itself rather than its tree; absent for a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_version: Option<String>,
    /// True when a walk budget stopped the folder digest, so `version` is the folder's own.
    pub shallow: bool,
    /// Size in bytes, as the entry itself reports it (a link's own length, not its target's).
    pub size: u64,
    /// What the path is, without following a final link.
    pub kind: Kind,
    /// Permission bits, `0o777` at most; what a save onto this path must carry over.
    pub mode: u64,
}

/// How a search compares case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Case {
    /// Exactly as typed.
    Sensitive,
    /// Ignore case.
    Insensitive,
    /// Ignore case when the pattern is all lowercase, match case otherwise.
    Smart,
}

/// What a `search` request looks for. Its fields are spread into the request alongside `root`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// The literal text or, with `regex`, a regular expression.
    pub pattern: String,
    /// True when `pattern` is a regular expression.
    pub regex: bool,
    /// How to compare case.
    pub case: Case,
    /// True to match whole words only.
    pub whole_word: bool,
    /// Globs a file must match to be searched.
    pub include: Vec<String>,
    /// Globs that keep a file out of the search.
    pub exclude: Vec<String>,
    /// True to search gitignored files too.
    pub include_ignored: bool,
    /// Stop after this many matches.
    pub max_matches: u64,
    /// Skip files larger than this many bytes.
    pub max_file_bytes: u64,
}

/// The matching lines of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    /// Root-relative path of the file.
    pub path: String,
    /// Its matching lines, in file order.
    pub lines: Vec<LineMatch>,
}

/// One matching line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based line number.
    pub line: u64,
    /// At most 400 bytes around the match, lossy UTF-8.
    pub preview: String,
    /// Byte ranges inside `preview` to highlight.
    pub ranges: Vec<(u32, u32)>,
}

/// How a finished search went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Files with at least one match.
    pub files: u64,
    /// Bytes read while searching.
    pub bytes: u64,
    /// Matching lines found.
    pub matches: u64,
    /// True when the search stopped at `max_matches`.
    pub limit_hit: bool,
}

/// One quick-open result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Root-relative path of a file.
    pub path: String,
    /// Higher is a better match.
    pub score: u32,
    /// Byte offsets inside `path` to highlight.
    pub positions: Vec<u32>,
}

/// The answer to an `indexQuery`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    /// The best matches, in rank order.
    pub hits: Vec<Hit>,
    /// How many files the index holds.
    pub total: u64,
    /// True when the index stopped at its file cap and misses paths.
    pub truncated: bool,
    /// True when the index finished building and answers every query.
    pub ready: bool,
}
