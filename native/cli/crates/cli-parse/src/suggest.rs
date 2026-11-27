// SPDX-License-Identifier: Apache-2.0
//! The nearest word to a typo (ADR 0178 §4): `thraed` → `thread`. Pure.

/// The optimal string alignment distance: one swapped pair of letters counts as one edit.
#[must_use]
pub fn distance(a: &str, b: &str) -> usize {
    strsim::osa_distance(a, b)
}

/// The closest candidate, or `None` when nothing is close enough to be a typo.
///
/// A candidate that starts with the typed word scores half an edit; scores are doubled to keep
/// that exact comparison in integers.
#[must_use]
pub fn nearest<'a>(word: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let typed = word.to_lowercase();
    let typed_len = typed.chars().count();
    let mut best: Option<(&'a str, usize)> = None;
    for candidate in candidates {
        if candidate.is_empty() || candidate.starts_with("__") {
            continue;
        }
        let score = if typed_len >= 3 && candidate.starts_with(&typed) {
            1
        } else {
            2 * distance(&typed, candidate)
        };
        if best.is_none_or(|(_, best_score)| score < best_score) {
            best = Some((candidate, score));
        }
    }
    let (candidate, score) = best?;
    let allowed = 2 * 1.max(typed_len.max(candidate.chars().count()) / 3);
    (score <= allowed).then_some(candidate)
}
