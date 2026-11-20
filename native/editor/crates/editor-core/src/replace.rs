// SPDX-License-Identifier: Apache-2.0

//! Replace: one match or all of them, with `$1` capture groups when the query is a regex.

use crate::document::Document;
use crate::find::{FindQuery, compile, is_whole_word};
use crate::position::Range;
use crate::transaction::{Applied, Edit, EditSet};

impl Document {
    /// Replaces every match inside `within` (the whole document when empty) as one undo step.
    ///
    /// In a regex query `$1`, `${name}` and `$0` insert capture groups and `\n`, `\t` and `\\`
    /// insert a line break, a tab and a backslash. Line breaks become the document's own ending.
    /// Selections move with the text around them.
    pub fn replace_all(
        &mut self,
        query: &FindQuery,
        replacement: &str,
        within: &[Range],
    ) -> Applied {
        let spans = self.match_spans(query, within, usize::MAX);
        if spans.is_empty() {
            return self.unchanged();
        }
        let edits = {
            let text = self.search_text();
            let regex = compile(query);
            spans
                .into_iter()
                .map(|(start, end)| Edit {
                    start,
                    end,
                    text: self.expanded(query, regex.as_ref(), &text, start, replacement),
                })
                .collect::<Vec<_>>()
        };
        self.apply_mapped(EditSet::new(edits))
    }

    /// Replaces the match at `at`, if `at` is exactly one of the query's matches.
    ///
    /// Returns an unchanged result when the text at `at` no longer matches, so a stale range
    /// from before an edit can never replace the wrong text.
    pub fn replace_match(&mut self, query: &FindQuery, at: Range, replacement: &str) -> Applied {
        let Some(regex) = compile(query) else {
            return self.unchanged();
        };
        let start = self.buffer.offset(at.start);
        let end = self.buffer.offset(at.end);
        let text = {
            let text = self.search_text();
            let Some(found) = regex.find_at(&text, start) else {
                return self.unchanged();
            };
            if found.start() != start || found.end() != end {
                return self.unchanged();
            }
            if query.whole_word && !is_whole_word(&text, start, end) {
                return self.unchanged();
            }
            self.expanded(query, Some(&regex), &text, start, replacement)
        };
        self.apply_edits(EditSet::new(vec![Edit { start, end, text }]), false)
    }

    /// The replacement for the match starting at `start`, with captures and escapes expanded.
    fn expanded(
        &self,
        query: &FindQuery,
        regex: Option<&regex::Regex>,
        text: &str,
        start: usize,
        replacement: &str,
    ) -> String {
        let ending = self.buffer.line_ending().as_str();
        let Some(regex) = regex.filter(|_| query.regex) else {
            return with_ending(replacement, ending);
        };
        let Some(captures) = regex.captures_at(text, start) else {
            return with_ending(replacement, ending);
        };
        let mut out = String::new();
        captures.expand(&unescape(replacement), &mut out);
        with_ending(&out, ending)
    }
}

/// `\n`, `\t` and `\\` in a regex replacement, as VS Code reads them.
fn unescape(replacement: &str) -> String {
    let mut out = String::with_capacity(replacement.len());
    let mut chars = replacement.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn with_ending(text: &str, ending: &str) -> String {
    if ending == "\n" || !text.contains('\n') {
        return text.replace("\r\n", "\n");
    }
    text.replace("\r\n", "\n").replace('\n', ending)
}
