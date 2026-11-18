// SPDX-License-Identifier: Apache-2.0

//! Applying an edit set: the rope changes, the inverse and the line spans for the highlighter.

use crate::document::Document;
use crate::transaction::{Applied, Edit, EditSet, LineEdit, shift};

/// The result of applying one set of changes: what the highlighter needs and the inverse edits.
pub(crate) struct Outcome {
    pub applied: Applied,
    pub inverse: EditSet,
}

impl Document {
    pub(crate) fn run(&mut self, edits: &EditSet) -> Outcome {
        if edits.is_empty() {
            return Outcome {
                applied: self.unchanged(),
                inverse: EditSet::default(),
            };
        }

        let mut old_ranges = Vec::with_capacity(edits.len());
        let mut post_starts = Vec::with_capacity(edits.len());
        let mut post_ends = Vec::with_capacity(edits.len());
        let mut inverse = Vec::with_capacity(edits.len());
        let mut delta: isize = 0;
        for edit in edits.edits() {
            old_ranges.push((
                self.buffer.line_at(edit.start),
                self.buffer.line_at(edit.end),
            ));
            let post_start = shift(edit.start, delta);
            post_starts.push(post_start);
            post_ends.push(post_start + edit.text.len());
            inverse.push(Edit {
                start: post_start,
                end: post_start + edit.text.len(),
                text: self.buffer.slice(edit.start, edit.end),
            });
            delta += edit.text.len() as isize - (edit.end - edit.start) as isize;
        }

        for edit in edits.edits().iter().rev() {
            self.buffer.remove(edit.start, edit.end);
            if !edit.text.is_empty() {
                self.buffer.insert(edit.start, &edit.text);
            }
        }

        self.version += 1;
        let spans = self.line_spans(&old_ranges, &post_starts, &post_ends);
        let (old_first, old_last) = match (old_ranges.first(), old_ranges.last()) {
            (Some((start, _)), Some((_, end))) => (*start, *end),
            _ => (0, 0),
        };
        let (first_line, removed_lines, inserted_lines) = overall_span(&spans, old_first, old_last);

        Outcome {
            applied: Applied {
                first_line,
                removed_lines,
                inserted_lines,
                spans,
                version: self.version,
            },
            inverse: EditSet::new(inverse),
        }
    }

    /// Groups changes whose old line spans share or touch a line and reports each group.
    fn line_spans(
        &self,
        old_ranges: &[(u32, u32)],
        post_starts: &[usize],
        post_ends: &[usize],
    ) -> Vec<LineEdit> {
        let mut spans = Vec::new();
        let mut open: Option<LineGroup> = None;
        for (index, (old_start, old_end)) in old_ranges.iter().copied().enumerate() {
            match open.take() {
                None => {
                    open = Some(LineGroup {
                        old_start,
                        old_end,
                        first: index,
                        last: index,
                    });
                }
                Some(mut group) => {
                    if old_start <= group.old_end.saturating_add(1) {
                        group.old_end = group.old_end.max(old_end);
                        group.last = index;
                        open = Some(group);
                    } else {
                        spans.push(self.line_edit(&group, post_starts, post_ends));
                        open = Some(LineGroup {
                            old_start,
                            old_end,
                            first: index,
                            last: index,
                        });
                    }
                }
            }
        }
        if let Some(group) = open {
            spans.push(self.line_edit(&group, post_starts, post_ends));
        }
        spans
    }

    fn line_edit(&self, group: &LineGroup, post_starts: &[usize], post_ends: &[usize]) -> LineEdit {
        let first_line = self.buffer.line_at(post_starts[group.first]);
        let last_line = self.buffer.line_at(post_ends[group.last]);
        LineEdit {
            first_line,
            removed_lines: group
                .old_end
                .saturating_sub(group.old_start)
                .saturating_add(1),
            inserted_lines: last_line.saturating_sub(first_line).saturating_add(1),
        }
    }
}

/// Maps byte offsets through a sorted, non-overlapping edit set in one pass.
pub(crate) struct OffsetMapper<'a> {
    edits: &'a [Edit],
    index: usize,
    delta: isize,
}

impl<'a> OffsetMapper<'a> {
    pub(crate) fn new(edits: &'a EditSet) -> OffsetMapper<'a> {
        OffsetMapper {
            edits: edits.edits(),
            index: 0,
            delta: 0,
        }
    }

    /// Maps an offset that is at or after every offset mapped before it.
    pub(crate) fn map(&mut self, offset: usize) -> usize {
        while let Some(edit) = self.edits.get(self.index) {
            if offset < edit.start {
                break;
            }
            if offset < edit.end {
                return shift(edit.start, self.delta) + edit.text.len();
            }
            self.delta += edit.text.len() as isize - (edit.end - edit.start) as isize;
            self.index += 1;
        }
        shift(offset, self.delta)
    }
}

struct LineGroup {
    old_start: u32,
    old_end: u32,
    first: usize,
    last: usize,
}

fn overall_span(spans: &[LineEdit], old_first: u32, old_last: u32) -> (u32, u32, u32) {
    let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
        return (0, 0, 0);
    };
    let first_line = first.first_line;
    let removed = old_last.saturating_sub(old_first).saturating_add(1);
    let inserted = last
        .first_line
        .saturating_add(last.inserted_lines)
        .saturating_sub(first_line);
    (first_line, removed, inserted)
}
