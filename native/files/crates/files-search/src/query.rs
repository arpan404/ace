// SPDX-License-Identifier: Apache-2.0

//! What to look for, in which files, and when to stop.

/// How a search compares letter case.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Case {
    /// Match the pattern's case exactly.
    Sensitive,
    /// Ignore case everywhere.
    Insensitive,
    /// Ignore case only while the pattern has no uppercase letters, as editors do.
    Smart,
}

/// One content search request.
#[derive(Clone, Debug)]
pub struct Query {
    /// The text or regular expression to find. Literal text is escaped for you.
    pub pattern: String,
    /// Treat `pattern` as a regular expression instead of literal text.
    pub regex: bool,
    /// How letter case is compared.
    pub case: Case,
    /// Match only whole words, not substrings inside longer words.
    pub whole_word: bool,
    /// Globs a file must match to be searched, relative to the root; empty means every file.
    pub include: Vec<String>,
    /// Globs of files and folders to leave out, relative to the root.
    pub exclude: Vec<String>,
    /// Search files that git ignores as well (`.gitignore`, `.git/info/exclude`).
    pub include_ignored: bool,
    /// Stop after this many matches; 0 means no limit.
    pub max_matches: usize,
    /// Skip files larger than this many bytes; 0 means no limit.
    pub max_file_bytes: u64,
}
