// SPDX-License-Identifier: Apache-2.0

//! Expand selection: each step takes the smallest larger unit around every selection, from the
//! word to the text inside the brackets, the brackets themselves, the line, the indented block
//! and finally the document.

use crate::document::Document;
use crate::selection::Selection;

/// How far an expansion scans for brackets around a selection, in characters each way.
const BRACKET_LIMIT: usize = 20_000;

/// How many lines an indented block may span before expansion goes to the whole document.
const BLOCK_LIMIT: usize = 5_000;

impl Document {
    /// Grows every selection to the smallest unit that strictly holds it. Returns false when
    /// every selection already covers the whole document.
    pub fn expand_selection(&mut self) -> bool {
        let mut changed = false;
        let selections: Vec<Selection> = self
            .selections
            .clone()
            .into_iter()
            .map(|selection| {
                let range = selection.range();
                let start = self.buffer.offset(range.start);
                let end = self.buffer.offset(range.end);
                match self.grown(start, end) {
                    Some((from, to)) => {
                        changed = true;
                        Selection::new(self.buffer.position(from), self.buffer.position(to))
                    }
                    None => selection,
                }
            })
            .collect();
        if changed {
            let primary = self.primary_selection();
            let mut ordered: Vec<Selection> = selections
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != primary)
                .map(|(_, selection)| *selection)
                .collect();
            if let Some(main) = selections.get(primary) {
                ordered.push(*main);
            }
            self.set_selections(ordered);
        }
        changed
    }

    /// The smallest candidate range that strictly contains `start..end`.
    fn grown(&self, start: usize, end: usize) -> Option<(usize, usize)> {
        let mut candidates: Vec<(usize, usize)> = Vec::with_capacity(8);
        if let Some(word) = self.buffer.word_at(start)
            && word.0 <= start
            && word.1 >= end
        {
            candidates.push(word);
        }
        if let Some((open, close)) = self.enclosing_brackets(start, end) {
            candidates.push((open + 1, close));
            candidates.push((open, close + 1));
        }
        let first = self.buffer.line_at(start) as usize;
        let last = self.buffer.line_at(end) as usize;
        let content_start =
            self.buffer.line_start(first) + self.buffer.leading_whitespace(first).len();
        let content_end = self.buffer.line_start(last) + self.buffer.line(last).len();
        candidates.push((content_start, content_end));
        candidates.push((self.buffer.line_start(first), content_end));
        if let Some(block) = self.indented_block(first, last) {
            candidates.push(block);
        }
        candidates.push((0, self.buffer.len_bytes()));
        candidates
            .into_iter()
            .filter(|(from, to)| *from <= start && *to >= end && (*from < start || *to > end))
            .min_by_key(|(from, to)| to - from)
    }

    /// The innermost bracket pair whose inside holds `start..end`, as the byte offsets of the
    /// opener and the closer.
    fn enclosing_brackets(&self, start: usize, end: usize) -> Option<(usize, usize)> {
        let before = self
            .buffer
            .slice(start.saturating_sub(BRACKET_LIMIT * 4), start);
        let mut depth = [0usize; 3];
        let mut offset = start;
        for ch in before.chars().rev() {
            offset -= ch.len_utf8();
            let kind = match ch {
                '(' | ')' => 0,
                '[' | ']' => 1,
                '{' | '}' => 2,
                _ => continue,
            };
            if matches!(ch, ')' | ']' | '}') {
                depth[kind] += 1;
                continue;
            }
            if depth[kind] > 0 {
                depth[kind] -= 1;
                continue;
            }
            let Some((open, close)) = self.buffer.matching_bracket(offset + 1, BRACKET_LIMIT)
            else {
                continue;
            };
            if open == offset && close >= end {
                return Some((open, close));
            }
        }
        None
    }

    /// Whole lines around `first..=last` indented at least as deep as the shallowest of them,
    /// blank lines included, ending at the last such line's text.
    fn indented_block(&self, first: usize, last: usize) -> Option<(usize, usize)> {
        let indent_of = |line: usize| {
            let text = self.buffer.line(line);
            (!text.trim().is_empty()).then(|| self.buffer.leading_whitespace(line).len())
        };
        let depth = (first..=last).filter_map(indent_of).min()?;
        if depth == 0 {
            return None;
        }
        let lines = self.buffer.len_lines();
        let mut top = first;
        while top > 0 && first - top < BLOCK_LIMIT && indent_of(top - 1).is_none_or(|d| d >= depth)
        {
            top -= 1;
        }
        let mut bottom = last;
        while bottom + 1 < lines
            && bottom - last < BLOCK_LIMIT
            && indent_of(bottom + 1).is_none_or(|d| d >= depth)
        {
            bottom += 1;
        }
        // Blank lines at either edge belong to whatever is around the block.
        while top < first && indent_of(top).is_none() {
            top += 1;
        }
        while bottom > last && indent_of(bottom).is_none() {
            bottom -= 1;
        }
        Some((
            self.buffer.line_start(top),
            self.buffer.line_start(bottom) + self.buffer.line(bottom).len(),
        ))
    }
}
