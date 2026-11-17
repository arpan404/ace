// SPDX-License-Identifier: Apache-2.0

//! Turns a matcher result into a single sortable score.
//!
//! Matching itself is the matcher crate's job; this module only decides which of two matches the
//! person is more likely to want. The rules, highest precedence first, are the ones the plan fixes:
//!
//! 1. A match that stays inside the file name beats one that needs folder characters.
//! 2. Among those, contiguous runs beat scattered characters, whatever folder or name the
//!    characters came from.
//! 3. More of the query inside the file name wins.
//! 4. Characters that start a path segment beat characters inside one.
//! 5. The matcher's own quality score breaks what is left.
//!
//! Rules 1 to 5 are packed into one `u32` in that order, so a plain integer comparison is the
//! ranking. Two hits with the same packed score are ordered by path length and then path bytes;
//! [`order`] applies that final tie-break, so "shorter paths win ties" never has to be encoded in
//! the score.

use std::cmp::Ordering;

/// Bit 31: every matched character fell inside the file name.
const NAME_COMPLETE: u32 = 1 << 31;
/// Bits 24 to 30: adjacent matched character pairs.
const RUN_SHIFT: u32 = 24;
const RUN_MASK: u32 = 0x7F;
/// Bits 16 to 23: matched characters inside the file name.
const NAME_SHIFT: u32 = 16;
const NAME_MASK: u32 = 0xFF;
/// Bits 8 to 15: matches on the first character of a path segment.
const BOUNDARY_SHIFT: u32 = 8;
const BOUNDARY_MASK: u32 = 0xFF;

/// Score the given byte positions for one path. `positions` must be sorted ascending; `matcher_score`
/// is the matcher's quality score for the same alignment.
pub(crate) fn score(path: &str, positions: &[u32], matcher_score: u16) -> u32 {
    if positions.is_empty() {
        return 0;
    }
    let name_start = path.rfind('/').map_or(0, |slash| slash + 1);
    let bytes = path.as_bytes();
    let mut in_name = 0u32;
    let mut runs = 0u32;
    let mut boundaries = 0u32;
    let mut previous: Option<u32> = None;
    for &position in positions {
        let index = usize::try_from(position).unwrap_or(usize::MAX);
        if index >= name_start {
            in_name += 1;
        }
        if index == 0 || bytes.get(index - 1) == Some(&b'/') {
            boundaries += 1;
        }
        if previous.is_some_and(|previous| previous.checked_add(1) == Some(position)) {
            runs += 1;
        }
        previous = Some(position);
    }
    let mut score = 0;
    if usize::try_from(in_name).is_ok_and(|in_name| in_name == positions.len()) {
        score |= NAME_COMPLETE;
    }
    score
        | ((in_name.min(NAME_MASK)) << NAME_SHIFT)
        | ((runs.min(RUN_MASK)) << RUN_SHIFT)
        | ((boundaries.min(BOUNDARY_MASK)) << BOUNDARY_SHIFT)
        | u32::from(matcher_score.min(255))
}

/// Whether a packed score says the whole match fell inside the file name.
pub(crate) fn in_name(score: u32) -> bool {
    score & NAME_COMPLETE != 0
}

/// Best first: descending score, then shorter path, then byte order. `Less` means the left hit is
/// listed first.
pub(crate) fn order(left: (u32, &str), right: (u32, &str)) -> Ordering {
    right
        .0
        .cmp(&left.0)
        .then_with(|| left.1.len().cmp(&right.1.len()))
        .then_with(|| left.1.cmp(right.1))
}
