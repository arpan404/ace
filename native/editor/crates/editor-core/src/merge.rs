// SPDX-License-Identifier: Apache-2.0

//! Three-way merge by line, for an unsaved buffer whose file changed on disk.
//!
//! `base` is the text the person started from, `mine` the buffer and `theirs` the disk. Each
//! side is diffed against the base by line (histogram diff, lines keep their own `\n` or
//! `\r\n`, so line endings come through as they were). A change only one side made lands as
//! it is. Changes the two sides made to the same or touching base lines form one block: when
//! both sides made it the same, it lands once; otherwise the block is a conflict carrying the
//! base, mine and theirs, for the person to answer.

use imara_diff::sources::lines;
use imara_diff::{Algorithm, Diff, Hunk, InternedInput};

/// One stretch of the merged text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeChunk {
    /// Text both sides agree on, or that only one side changed.
    Clean(String),
    /// A block both sides changed differently: the base text of that block and each side's.
    Conflict {
        /// The block as it was in the base.
        base: String,
        /// The block as the buffer has it.
        mine: String,
        /// The block as the disk has it.
        theirs: String,
    },
}

/// The result of [`merge3`]: the merged text as clean stretches and conflicting blocks, in
/// order. Consecutive clean text is one chunk.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Merge {
    chunks: Vec<MergeChunk>,
}

impl Merge {
    /// The chunks in reading order.
    pub fn chunks(&self) -> &[MergeChunk] {
        &self.chunks
    }

    /// The chunks, owned.
    pub fn into_chunks(self) -> Vec<MergeChunk> {
        self.chunks
    }

    /// True when no block conflicts.
    pub fn is_clean(&self) -> bool {
        self.chunks
            .iter()
            .all(|chunk| matches!(chunk, MergeChunk::Clean(_)))
    }

    /// The merged text, or `None` while any block conflicts.
    pub fn text(&self) -> Option<String> {
        let mut text = String::new();
        for chunk in &self.chunks {
            match chunk {
                MergeChunk::Clean(clean) => text.push_str(clean),
                MergeChunk::Conflict { .. } => return None,
            }
        }
        Some(text)
    }
}

/// Merges `mine` and `theirs`, both edits of `base`. See the module docs for the rules.
pub fn merge3(base: &str, mine: &str, theirs: &str) -> Merge {
    let base_lines: Vec<&str> = lines(base).collect();
    let mine_lines: Vec<&str> = lines(mine).collect();
    let theirs_lines: Vec<&str> = lines(theirs).collect();

    // One interner for all three texts, so the base is cut and hashed once.
    let mut input = InternedInput::new(base, mine);
    let ours = hunks(&input);
    input.update_after(lines(theirs));
    let other = hunks(&input);

    let base_side = Text(&base_lines);
    let mine_side = Side {
        hunks: &ours,
        lines: &mine_lines,
    };
    let theirs_side = Side {
        hunks: &other,
        lines: &theirs_lines,
    };

    let mut out = Builder::default();
    let mut at = 0;
    let (mut i, mut j) = (0, 0);
    while let Some(first) = earliest(ours.get(i), other.get(j)) {
        let start = first.before.start;
        let mut end = first.before.end;
        let (i0, j0) = (i, j);
        // Pull in every hunk, from either side, that overlaps or touches the block so far.
        loop {
            if let Some(hunk) = ours.get(i).filter(|hunk| hunk.before.start <= end) {
                end = end.max(hunk.before.end);
                i += 1;
            } else if let Some(hunk) = other.get(j).filter(|hunk| hunk.before.start <= end) {
                end = end.max(hunk.before.end);
                j += 1;
            } else {
                break;
            }
        }

        out.clean(base_side.span(at, start));
        let block = start..end;
        if j == j0 {
            out.clean_owned(mine_side.block(&base_side, block, i0..i));
        } else if i == i0 {
            out.clean_owned(theirs_side.block(&base_side, block, j0..j));
        } else {
            let mine_text = mine_side.block(&base_side, block.clone(), i0..i);
            let theirs_text = theirs_side.block(&base_side, block.clone(), j0..j);
            if mine_text == theirs_text {
                out.clean_owned(mine_text);
            } else {
                out.conflict(MergeChunk::Conflict {
                    base: base_side.span(start, end).concat(),
                    mine: mine_text,
                    theirs: theirs_text,
                });
            }
        }
        at = end;
    }
    out.clean(base_side.span(at, len(&base_lines)));
    Merge {
        chunks: out.finish(),
    }
}

/// Lines `start..end` of the old text (0-based, end exclusive) become `text`, which carries its
/// own line endings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineChange {
    /// The first replaced line of the old text.
    pub start: u32,
    /// One past the last replaced line; equal to `start` for an insertion.
    pub end: u32,
    /// The new lines, with their endings.
    pub text: String,
}

/// How to turn `before` into `after` by whole lines, one change per changed block, in order.
/// Applied to a document, text between the blocks (and the carets in it) does not move.
pub fn line_changes(before: &str, after: &str) -> Vec<LineChange> {
    let after_lines: Vec<&str> = lines(after).collect();
    let input = InternedInput::new(before, after);
    hunks(&input)
        .into_iter()
        .map(|hunk| LineChange {
            start: hunk.before.start,
            end: hunk.before.end,
            text: slice(&after_lines, hunk.after.start, hunk.after.end).concat(),
        })
        .collect()
}

fn hunks(input: &InternedInput<&str>) -> Vec<Hunk> {
    let mut diff = Diff::compute(Algorithm::Histogram, input);
    diff.postprocess_lines(input);
    diff.hunks().collect()
}

/// The hunk that starts first in the base; an insertion before a change at the same line.
fn earliest<'h>(ours: Option<&'h Hunk>, theirs: Option<&'h Hunk>) -> Option<&'h Hunk> {
    match (ours, theirs) {
        (Some(a), Some(b)) => {
            if (b.before.start, b.before.end) < (a.before.start, a.before.end) {
                Some(b)
            } else {
                Some(a)
            }
        }
        (a, b) => a.or(b),
    }
}

fn len(lines: &[&str]) -> u32 {
    u32::try_from(lines.len()).unwrap_or(u32::MAX)
}

fn slice<'t>(lines: &'t [&'t str], from: u32, to: u32) -> &'t [&'t str] {
    lines.get(from as usize..to as usize).unwrap_or_default()
}

/// The base text's lines.
struct Text<'t>(&'t [&'t str]);

impl<'t> Text<'t> {
    fn span(&self, from: u32, to: u32) -> &'t [&'t str] {
        slice(self.0, from, to)
    }
}

/// One side of the merge: its hunks against the base and its own lines.
struct Side<'s> {
    hunks: &'s [Hunk],
    lines: &'s [&'s str],
}

impl Side<'_> {
    /// The base block `block` as this side has it, applying its hunks `range` inside it.
    fn block(
        &self,
        base: &Text<'_>,
        block: std::ops::Range<u32>,
        range: std::ops::Range<usize>,
    ) -> String {
        let mut text = String::new();
        let mut at = block.start;
        for hunk in self.hunks.get(range).unwrap_or_default() {
            text.extend(base.span(at, hunk.before.start).iter().copied());
            text.extend(
                slice(self.lines, hunk.after.start, hunk.after.end)
                    .iter()
                    .copied(),
            );
            at = hunk.before.end;
        }
        text.extend(base.span(at, block.end).iter().copied());
        text
    }
}

/// Collects chunks, joining consecutive clean text into one.
#[derive(Default)]
struct Builder {
    chunks: Vec<MergeChunk>,
    pending: String,
}

impl Builder {
    fn clean(&mut self, lines: &[&str]) {
        self.pending.extend(lines.iter().copied());
    }

    fn clean_owned(&mut self, text: String) {
        if self.pending.is_empty() {
            self.pending = text;
        } else {
            self.pending.push_str(&text);
        }
    }

    fn conflict(&mut self, chunk: MergeChunk) {
        self.flush();
        self.chunks.push(chunk);
    }

    fn flush(&mut self) {
        if !self.pending.is_empty() {
            self.chunks
                .push(MergeChunk::Clean(std::mem::take(&mut self.pending)));
        }
    }

    fn finish(mut self) -> Vec<MergeChunk> {
        self.flush();
        self.chunks
    }
}
