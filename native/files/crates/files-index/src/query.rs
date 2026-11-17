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

/// One term's result for one path: the matcher's score and the matched byte offsets.
type Found = (u16, Vec<u32>);

/// One whitespace-separated piece of the query. Every piece has to match; the term that contains a
/// `/` names path segments and is never retried against the file name alone.
struct Term {
    text: String,
    has_slash: bool,
}

struct Parsed {
    terms: Vec<Term>,
}

impl Parsed {
    fn new(query: &str) -> Parsed {
        Parsed {
            terms: query
                .split_whitespace()
                .map(|text| Term {
                    text: text.to_owned(),
                    has_slash: text.contains('/'),
                })
                .collect(),
        }
    }
}

pub(crate) fn search(arena: &PathArena, query: &str, limit: usize) -> Vec<Hit> {
    let parsed = Parsed::new(query);
    if parsed.terms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let config = config();
    let starts: Vec<u32> = (0..arena.slots()).step_by(CHUNK as usize).collect();
    let heaps: Vec<TopK<'_>> = starts
        .par_iter()
        .map(|&start| search_chunk(arena, &parsed, &config, limit, start))
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
    let mut matchers = matchers(&parsed, &config);
    winners
        .into_iter()
        .map(|candidate| {
            let path = arena.get(candidate.slot).unwrap_or_default();
            let (score, positions) =
                score_path(&mut matchers, &parsed, path).unwrap_or((candidate.score, Vec::new()));
            Hit {
                path: path.to_owned(),
                score,
                positions,
            }
        })
        .collect()
}

fn search_chunk<'a>(
    arena: &'a PathArena,
    query: &Parsed,
    config: &Config,
    limit: usize,
    start: u32,
) -> TopK<'a> {
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
    let mut matchers = matchers(query, config);
    let mut per_term: Vec<Vec<Option<Found>>> = Vec::with_capacity(query.terms.len());
    for matcher in &mut matchers {
        let mut found: Vec<Option<Found>> = Vec::new();
        found.resize_with(paths.len(), || None);
        for hit in matcher.match_list_indices(&paths) {
            if let Ok(index) = usize::try_from(hit.index)
                && let Some(entry) = found.get_mut(index)
            {
                *entry = Some((hit.score, hit.indices));
            }
        }
        per_term.push(found);
    }
    for (index, path) in paths.iter().enumerate() {
        let mut total = 0u32;
        let mut positions = Vec::new();
        let mut complete = true;
        for (term_index, matcher) in matchers.iter_mut().enumerate() {
            let found = per_term
                .get_mut(term_index)
                .and_then(|found| found.get_mut(index))
                .and_then(Option::take);
            let (Some((score, indices)), Some(term)) = (found, query.terms.get(term_index)) else {
                complete = false;
                break;
            };
            let (term_score, term_positions) = term_hit(matcher, term, path, score, indices);
            total = total.saturating_add(term_score);
            positions.extend(term_positions);
        }
        if !complete {
            continue;
        }
        positions.sort_unstable();
        positions.dedup();
        if let Some(slot) = slots.get(index) {
            top.push(Candidate {
                score: total,
                slot: *slot,
            });
        }
    }
    top
}

/// Score one path for every term, for the few winners that become hits.
fn score_path(matchers: &mut [Matcher], query: &Parsed, path: &str) -> Option<(u32, Vec<u32>)> {
    let mut total = 0u32;
    let mut positions = Vec::new();
    for (term, matcher) in query.terms.iter().zip(matchers.iter_mut()) {
        let found = matcher.match_one_indices(path, 0)?;
        let (score, term_positions) = term_hit(matcher, term, path, found.score, found.indices);
        total = total.saturating_add(score);
        positions.extend(term_positions);
    }
    positions.sort_unstable();
    positions.dedup();
    Some((total, positions))
}

/// One term's contribution. When the term has no `/` and the best alignment needed folder
/// characters, the file name alone is tried too: a match wholly inside the name is what a person
/// searching a file is after, and it keeps the higher packed score.
fn term_hit(
    matcher: &mut Matcher,
    term: &Term,
    path: &str,
    score: u16,
    mut indices: Vec<u32>,
) -> (u32, Vec<u32>) {
    clean(path, &mut indices);
    let packed = ranking::score(path, &indices, score);
    if term.has_slash || ranking::in_name(packed) {
        return (packed, indices);
    }
    let name_start = path.rfind('/').map_or(0, |slash| slash + 1);
    let name = &path[name_start..];
    if !could_match(name, &term.text) {
        return (packed, indices);
    }
    let Some(found) = matcher.match_one_indices(name, 0) else {
        return (packed, indices);
    };
    let mut name_indices = found.indices;
    clean(name, &mut name_indices);
    let name_packed = ranking::score(name, &name_indices, found.score);
    if name_packed <= packed {
        return (packed, indices);
    }
    let shift = u32::try_from(name_start).unwrap_or(u32::MAX);
    let shifted = name_indices
        .into_iter()
        .filter_map(|position| position.checked_add(shift))
        .collect();
    (name_packed, shifted)
}

/// A cheap "the letters are in there in order" test, so the matcher only scores a file name that
/// can possibly match. Bytes and ASCII case are enough: a false positive costs one matcher call.
fn could_match(name: &str, term: &str) -> bool {
    let mut wanted = term.bytes().map(|byte| byte.to_ascii_lowercase());
    let mut next = wanted.next();
    for byte in name.bytes() {
        let Some(target) = next else {
            return true;
        };
        if byte.to_ascii_lowercase() == target {
            next = wanted.next();
        }
    }
    next.is_none()
}

/// Sort, drop repeats, and keep only positions that point at the start of a character.
fn clean(path: &str, positions: &mut Vec<u32>) {
    positions.sort_unstable();
    positions.dedup();
    let length = u32::try_from(path.len()).unwrap_or(u32::MAX);
    positions.retain(|&position| position < length && path.is_char_boundary(position as usize));
}

fn matchers(query: &Parsed, config: &Config) -> Vec<Matcher> {
    query
        .terms
        .iter()
        .map(|term| Matcher::new(term.text.as_str(), config))
        .collect()
}

/// Quick open ignores case and never allows a typo: a query has to be a subsequence of the path,
/// with gaps only. The matcher is told to keep input order so the ranking here decides the result.
fn config() -> Config {
    Config::default()
        .sort(SortStrategy::IndexAsc)
        .casing(CaseMatching::Ignore)
        .max_typos(Some(0))
}
