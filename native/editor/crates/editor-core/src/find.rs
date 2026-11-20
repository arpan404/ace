// SPDX-License-Identifier: Apache-2.0

//! Find queries: literal or regular expression, case and whole-word options.

use regex::{Regex, RegexBuilder};

use crate::buffer::is_word_char;
use crate::document::Document;
use crate::position::Range;

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
        .multi_line(true)
        .crlf(true)
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

impl Document {
    /// Finds matches for a query, at most `limit` of them, in document order.
    ///
    /// A pattern that is not a valid regular expression finds nothing; callers validate queries
    /// before they reach the editor. Zero-length matches such as `^` are returned as empty
    /// ranges so anchors still work. The text is cached between finds and rebuilt only after the
    /// document version changes.
    pub fn find(&self, query: &FindQuery, limit: usize) -> Vec<Range> {
        if limit == 0 {
            return Vec::new();
        }
        let Some(regex) = compile(query) else {
            return Vec::new();
        };
        let stale = self
            .search_text
            .borrow()
            .as_ref()
            .is_none_or(|(version, _)| *version != self.version);
        if stale {
            let text = self.buffer.text();
            *self.search_text.borrow_mut() = Some((self.version, text));
        }
        let cache = self.search_text.borrow();
        let Some((_, text)) = cache.as_ref() else {
            return Vec::new();
        };
        let mut ranges = Vec::new();
        for matched in regex.find_iter(text) {
            if query.whole_word && !is_whole_word(text, matched.start(), matched.end()) {
                continue;
            }
            ranges.push(Range::new(
                self.buffer.position(matched.start()),
                self.buffer.position(matched.end()),
            ));
            if ranges.len() >= limit {
                break;
            }
        }
        ranges
    }
}
