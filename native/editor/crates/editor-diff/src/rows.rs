// SPDX-License-Identifier: Apache-2.0

//! The line diff behind the gutter: a port of `diffTexts` in `packages/ui-core/src/diff.ts`,
//! so the gutter and the diff view attribute a change to the same line.
//!
//! Shared ends become context, the middle is diffed with an LCS that takes removals before
//! additions on a tie (as a unified diff does), and above [`MAX_CELLS`] the middle is split
//! at the lines that occur once on each side and match in order, as patience diff does,
//! recursing into each piece between them.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::hash::{BuildHasherDefault, Hasher};

/// One row of the diff, in reading order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Row {
    /// A line both texts have, at 1-based line `new` of the current text.
    Context { new: usize },
    /// A line only the current text has.
    Add { new: usize },
    /// A line only the original has.
    Del,
}

/// Above this many cells the middle is split at anchors rather than diffed whole, which
/// keeps a large rewrite fast without changing which lines a reader sees as changed.
const MAX_CELLS: usize = 4_000_000;

pub(super) fn diff(before: &[&str], after: &[&str]) -> Vec<Row> {
    let mut rows = Vec::with_capacity(before.len().max(after.len()));
    span(before, after, 0, &mut rows);
    rows
}

/// Shared head and tail lines are context; only the middle between them is diffed.
fn span(before: &[&str], after: &[&str], new_base: usize, rows: &mut Vec<Row>) {
    let mut head = 0;
    while head < before.len() && head < after.len() && before[head] == after[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < before.len() - head
        && tail < after.len() - head
        && before[before.len() - 1 - tail] == after[after.len() - 1 - tail]
    {
        tail += 1;
    }
    for index in 0..head {
        rows.push(Row::Context {
            new: new_base + index + 1,
        });
    }
    middle(
        &before[head..before.len() - tail],
        &after[head..after.len() - tail],
        new_base + head,
        rows,
    );
    for index in (1..=tail).rev() {
        rows.push(Row::Context {
            new: new_base + (after.len() - index) + 1,
        });
    }
}

fn middle(before: &[&str], after: &[&str], new_base: usize, rows: &mut Vec<Row>) {
    let n = before.len();
    let m = after.len();
    if n.saturating_mul(m) > MAX_CELLS {
        split_at_anchors(before, after, new_base, rows);
        return;
    }

    // lengths[i][j] is the LCS of before[i..] and after[j..], flattened row by row.
    let width = m + 1;
    let mut lengths = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lengths[i * width + j] = if before[i] == after[j] {
                lengths[(i + 1) * width + j + 1] + 1
            } else {
                lengths[(i + 1) * width + j].max(lengths[i * width + j + 1])
            };
        }
    }

    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && before[i] == after[j] {
            rows.push(Row::Context {
                new: new_base + j + 1,
            });
            i += 1;
            j += 1;
        } else if i < n && (j >= m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
            rows.push(Row::Del);
            i += 1;
        } else {
            rows.push(Row::Add {
                new: new_base + j + 1,
            });
            j += 1;
        }
    }
}

/// The large-middle branch: anchor on the ordered lines both sides have exactly once, and
/// diff the pieces between them. With no such line, the whole middle is a replacement.
fn split_at_anchors(before: &[&str], after: &[&str], new_base: usize, rows: &mut Vec<Row>) {
    let anchors = anchors(before, after);
    if anchors.is_empty() {
        rows.resize(rows.len() + before.len(), Row::Del);
        for j in 0..after.len() {
            rows.push(Row::Add {
                new: new_base + j + 1,
            });
        }
        return;
    }

    let (mut i, mut j) = (0, 0);
    for (at, bt) in anchors {
        span(&before[i..at], &after[j..bt], new_base + j, rows);
        rows.push(Row::Context {
            new: new_base + bt + 1,
        });
        i = at + 1;
        j = bt + 1;
    }
    span(&before[i..], &after[j..], new_base + j, rows);
}

/// `(before index, after index)` pairs of lines that occur exactly once on each side, in the
/// longest run that is in order on both sides.
fn anchors(before: &[&str], after: &[&str]) -> Vec<(usize, usize)> {
    /// Map value for a line that occurs more than once in `before`: never an anchor.
    const REPEATED: usize = usize::MAX;
    /// A line of `before` no line of `after` has matched.
    const UNMATCHED: usize = usize::MAX;
    /// A line of `before` more than one line of `after` has matched.
    const MATCHED_TWICE: usize = usize::MAX - 1;

    let mut first: HashMap<&str, usize, BuildHasherDefault<LineHasher>> =
        HashMap::with_capacity_and_hasher(before.len(), BuildHasherDefault::default());
    for (index, line) in before.iter().enumerate() {
        match first.entry(*line) {
            Entry::Occupied(mut entry) => {
                entry.insert(REPEATED);
            }
            Entry::Vacant(slot) => {
                slot.insert(index);
            }
        }
    }

    // `matched[at]` is the line of `after` that line `at` of `before` was matched with. One
    // pass over `after` fills it, so the pairs come out in `before` order without another
    // lookup per line.
    let mut matched = vec![UNMATCHED; before.len()];
    for (index, line) in after.iter().enumerate() {
        let Some(&at) = first.get(*line) else {
            continue;
        };
        if at != REPEATED {
            matched[at] = if matched[at] == UNMATCHED {
                index
            } else {
                MATCHED_TWICE
            };
        }
    }

    let mut pairs: Vec<(usize, usize)> = Vec::with_capacity(before.len());
    for (index, &bt) in matched.iter().enumerate() {
        if bt != UNMATCHED && bt != MATCHED_TWICE {
            pairs.push((index, bt));
        }
    }

    // Edits usually keep the anchors in order on both sides (lines are replaced, or shifted
    // by insertions and deletions). Then every pair is the run and no search is needed.
    if pairs.windows(2).all(|pair| pair[0].1 < pair[1].1) {
        return pairs;
    }

    // The longest increasing run of after indexes: `tails` holds each length's smallest end
    // as (after index, pair), and `previous` links a pair to the one before it in its run.
    let mut tails: Vec<(usize, usize)> = Vec::new();
    let mut previous: Vec<usize> = vec![usize::MAX; pairs.len()];
    for (index, &(_, bt)) in pairs.iter().enumerate() {
        let mut low = 0;
        let mut high = tails.len();
        while low < high {
            let mid = (low + high) / 2;
            if tails[mid].0 < bt {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if low > 0 {
            previous[index] = tails[low - 1].1;
        }
        if low == tails.len() {
            tails.push((bt, index));
        } else {
            tails[low] = (bt, index);
        }
    }

    let mut run = Vec::with_capacity(tails.len());
    let mut index = tails.last().map(|&(_, index)| index);
    while let Some(at) = index {
        run.push(pairs[at]);
        let earlier = previous[at];
        index = (earlier != usize::MAX).then_some(earlier);
    }
    run.reverse();
    run
}

/// Hashes line keys a word at a time. The map still compares the lines themselves, so a
/// collision costs one comparison and never changes which lines are anchors.
#[derive(Default)]
struct LineHasher(u64);

impl Hasher for LineHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut hash = self.0;
        let mut chunks = bytes.chunks_exact(8);
        for chunk in &mut chunks {
            let mut word = [0u8; 8];
            word.copy_from_slice(chunk);
            hash = mix(hash, u64::from_le_bytes(word));
        }
        let rest = chunks.remainder();
        if !rest.is_empty() {
            let mut word = [0u8; 8];
            word[..rest.len()].copy_from_slice(rest);
            hash = mix(hash, u64::from_le_bytes(word));
        }
        self.0 = hash;
    }
}

fn mix(hash: u64, word: u64) -> u64 {
    (hash.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95)
}
