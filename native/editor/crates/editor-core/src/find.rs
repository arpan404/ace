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
        self.find_within(query, &[], limit)
    }

    /// Finds matches that lie wholly inside one of `within`, at most `limit`, in document order.
    ///
    /// An empty `within` searches the whole document. Ranges may come in any order and may
    /// overlap; a match must fit inside one of them.
    pub fn find_within(&self, query: &FindQuery, within: &[Range], limit: usize) -> Vec<Range> {
        self.match_spans(query, within, limit)
            .into_iter()
            .map(|(start, end)| Range::new(self.buffer.position(start), self.buffer.position(end)))
            .collect()
    }

    /// Byte spans of the query's matches inside `within` (everything when empty).
    pub(crate) fn match_spans(
        &self,
        query: &FindQuery,
        within: &[Range],
        limit: usize,
    ) -> Vec<(usize, usize)> {
        if limit == 0 {
            return Vec::new();
        }
        let Some(regex) = compile(query) else {
            return Vec::new();
        };
        let bounds = self.byte_bounds(within);
        let text = self.search_text();
        let mut spans = Vec::new();
        let mut bound = 0;
        for matched in regex.find_iter(&text) {
            let (start, end) = (matched.start(), matched.end());
            if query.whole_word && !is_whole_word(&text, start, end) {
                continue;
            }
            if !bounds.is_empty() {
                // Matches come in order, so a bound that ends before this match can hold no later one.
                while bounds.get(bound).is_some_and(|(_, high)| *high < end) {
                    bound += 1;
                }
                let Some((low, _)) = bounds.get(bound) else {
                    break;
                };
                if start < *low {
                    continue;
                }
            }
            spans.push((start, end));
            if spans.len() >= limit {
                break;
            }
        }
        spans
    }

    /// The whole text, cached until the version moves.
    pub(crate) fn search_text(&self) -> std::cell::Ref<'_, String> {
        let stale = self
            .search_text
            .borrow()
            .as_ref()
            .is_none_or(|(version, _)| *version != self.version);
        if stale {
            let text = self.buffer.text();
            *self.search_text.borrow_mut() = Some((self.version, text));
        }
        std::cell::Ref::map(self.search_text.borrow(), |cache| match cache {
            Some((_, text)) => text,
            None => empty_text(),
        })
    }

    /// Ranges as sorted, merged byte spans.
    fn byte_bounds(&self, within: &[Range]) -> Vec<(usize, usize)> {
        let mut bounds: Vec<(usize, usize)> = within
            .iter()
            .map(|range| {
                (
                    self.buffer.offset(range.start),
                    self.buffer.offset(range.end),
                )
            })
            .collect();
        bounds.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(bounds.len());
        for (start, end) in bounds {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        merged
    }
}

fn empty_text() -> &'static String {
    static EMPTY: String = String::new();
    &EMPTY
}
