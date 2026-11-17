// SPDX-License-Identifier: Apache-2.0

//! Fuzzy search over the arena.

use frizbee::{CaseMatching, Config, Matcher, SortStrategy};
use rayon::prelude::*;

use crate::Hit;
use crate::arena::PathArena;
use crate::ranking;
use crate::topk::{Candidate, TopK};

/// Paths per parallel batch. Small enough to keep the per-batch buffers in cache, large enough that
/// the matcher's per-call setup disappears in the work.
const CHUNK: u32 = 4096;

pub(crate) fn search(arena: &PathArena, query: &str, limit: usize) -> Vec<Hit> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }
    let slots = arena.slots();
    let starts: Vec<u32> = (0..slots).step_by(CHUNK as usize).collect();
    let heaps: Vec<TopK<'_>> = starts
        .par_iter()
        .map(|&start| search_chunk(arena, query, limit, start))
        .collect();
    let mut merged = TopK::new(limit, arena);
    for heap in heaps {
        for candidate in heap.into_sorted() {
            merged.push(candidate);
        }
    }
    let winners = merged.into_sorted();
    if winners.is_empty() {
        return Vec::new();
    }
    let mut matcher = Matcher::new(query, &config());
    winners
        .into_iter()
        .map(|candidate| {
            let path = arena.get(candidate.slot).unwrap_or_default();
            let mut positions = matcher
                .match_one_indices(path, candidate.slot)
                .map(|found| found.indices)
                .unwrap_or_default();
            positions.sort_unstable();
            Hit {
                path: path.to_owned(),
                score: candidate.score,
                positions,
            }
        })
        .collect()
}

fn search_chunk<'a>(arena: &'a PathArena, query: &str, limit: usize, start: u32) -> TopK<'a> {
    let end = start.saturating_add(CHUNK).min(arena.slots());
    let mut paths: Vec<&'a str> = Vec::with_capacity(usize::try_from(end - start).unwrap_or(0));
    let mut slots: Vec<u32> = Vec::with_capacity(paths.capacity());
    for slot in start..end {
        if !arena.is_live(slot) {
            continue;
        }
        if let Some(path) = arena.get(slot) {
            paths.push(path);
            slots.push(slot);
        }
    }
    let mut top = TopK::new(limit, arena);
    if paths.is_empty() {
        return top;
    }
    let mut matcher = Matcher::new(query, &config());
    for found in matcher.match_list_indices(&paths) {
        let Ok(index) = usize::try_from(found.index) else {
            continue;
        };
        let (Some(path), Some(slot)) = (paths.get(index), slots.get(index)) else {
            continue;
        };
        let mut positions = found.indices;
        positions.sort_unstable();
        top.push(Candidate {
            score: ranking::score(path, &positions, found.score),
            slot: *slot,
        });
    }
    top
}

/// Quick open ignores case and never allows a typo: a query has to be a subsequence of the path,
/// with gaps only. The matcher is told to keep input order so the ranking here decides the result.
fn config() -> Config {
    Config::default()
        .sort(SortStrategy::IndexAsc)
        .casing(CaseMatching::Ignore)
        .max_typos(Some(0))
}
