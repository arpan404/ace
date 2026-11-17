// SPDX-License-Identifier: Apache-2.0

//! Find queries: literal or regular expression, case and whole-word options.

use regex::{Regex, RegexBuilder};

use crate::buffer::is_word_char;

/// What to search for in a document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FindQuery {
    /// The text or regular expression to find.
    pub pattern: String,
    /// Whether `pattern` is a regular expression rather than literal text.
    pub regex: bool,
    /// Whether case differences are significant.
    pub case_sensitive: bool,
    /// Whether matches must stand alone as words.
    pub whole_word: bool,
}

impl FindQuery {
    /// A case-sensitive literal query with no whole-word restriction.
    pub fn new(pattern: impl Into<String>) -> FindQuery {
        FindQuery {
            pattern: pattern.into(),
            regex: false,
            case_sensitive: true,
            whole_word: false,
        }
    }
}

/// Compiles a query into a regex, escaping it when it is literal. Invalid patterns yield `None`.
pub(crate) fn compile(query: &FindQuery) -> Option<Regex> {
    if query.pattern.is_empty() {
        return None;
    }
    let pattern = if query.regex {
        query.pattern.clone()
    } else {
        regex::escape(&query.pattern)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .build()
        .ok()
}

/// Whether the match at `start..end` has no word character immediately outside it.
pub(crate) fn is_whole_word(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
}

/// Byte spans of every non-overlapping occurrence of a literal string.
pub(crate) fn occurrences(text: &str, needle: &str) -> Vec<(usize, usize)> {
    if needle.is_empty() {
        return Vec::new();
    }
    text.match_indices(needle)
        .map(|(start, matched)| (start, start + matched.len()))
        .collect()
}
