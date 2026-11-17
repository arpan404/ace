// SPDX-License-Identifier: Apache-2.0

//! What the sink receives and what the search reports when it returns.

/// Every matching line in one file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileMatches {
    /// The file's path relative to the search root, `/` separated.
    pub path: String,
    /// The matching lines in file order.
    pub lines: Vec<LineMatch>,
}

/// One line that contains at least one match.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LineMatch {
    /// The 1-based line number.
    pub line: u64,
    /// At most 400 bytes of the line around the match, decoded leniently as UTF-8.
    pub preview: String,
    /// Byte offsets of the matched text inside `preview`.
    pub ranges: Vec<(u32, u32)>,
}

/// What a finished search found.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Summary {
    /// Files that had at least one match.
    pub files: u64,
    /// Bytes of file content handed to the searcher, including files with no match.
    pub bytes: u64,
    /// Match occurrences reported to the sink.
    pub matches: u64,
    /// True when matches existed beyond the limit and were not reported.
    pub limit_hit: bool,
}
