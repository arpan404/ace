//! Old tool results age out of the prompt when the person turns `age_results` on (ADR 0216; off
//! by default, so models see full output). A long result the bot read many steps ago
//! is shown in later prompts as a short stub that says what it was and how to get it back; the
//! person's words, the bot's own words, questions and answers, errors and recent results are
//! always shown whole.
//!
//! Aging is fixed by stored events: `results_aged { before }` says every result before that index
//! that may age is a stub. Spade stores one only when enough can go at once ([`BATCH_CHARS`]), so
//! between two of them each prompt only grows at its end and the provider's prompt cache holds.
//! Pure: the engine stores what [`due`] answers.

use serde_json::Value;

use crate::event::{Event, Known};

/// The results of the latest steps are always shown whole...
pub const KEEP_STEPS: usize = 4;
/// ...and so are at least this many of the latest results, whatever steps they came in.
pub const KEEP_RESULTS: usize = 8;
/// A result this short or shorter stays: its stub would save little.
pub const MIN_CHARS: usize = 2_000;
/// A new boundary is stored only when at least this much result text (about 16,000 tokens) can
/// age at once, so the prompt's earlier bytes change seldom.
pub const BATCH_CHARS: usize = 64_000;

/// Tools whose results never age: the person's answers, skills the bot is following, and the
/// tools it found to call.
const NEVER: [&str; 3] = [
    crate::context::ASK_USER,
    "skill_load",
    crate::tools::TOOL_SEARCH,
];

/// Whether a result of `name` may age at all: long enough to be worth it, no error (one the bot
/// may still be dealing with), no image (shown beside it) and not from a tool in [`NEVER`].
pub fn may_age(name: &str, content: &str, is_error: bool, has_images: bool) -> bool {
    !is_error && !has_images && content.len() > MIN_CHARS && !NEVER.contains(&name)
}

/// The aging in effect: results before the returned index (and at or after `from`, the last
/// compaction's cut) show as stubs. Reads back only as far as the prompt reaches: to the latest
/// `results_aged`, or to the cut of the latest compaction, so the work is the prompt's size,
/// never the history's.
pub fn boundary(events: &[Event]) -> usize {
    let mut floor: Option<usize> = None;
    for at in (0..events.len()).rev() {
        if floor.is_some_and(|f| at < f) {
            break;
        }
        match &events[at] {
            Event::Known(Known::ResultsAged { before }) => return *before,
            Event::Known(Known::ContextCompacted { keep_from, .. }) if floor.is_none() => {
                floor = Some(*keep_from);
            }
            _ => {}
        }
    }
    0
}

/// The span the prompt shows, from the latest compaction's cut on.
fn shown_from(events: &[Event]) -> usize {
    events
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::Known(Known::ContextCompacted { keep_from, .. }) => Some(*keep_from),
            _ => None,
        })
        .unwrap_or(0)
        .min(events.len())
}

/// The boundary to store before the next model call, if a batch is due: the start of the
/// [`KEEP_STEPS`]th latest step, moved back until [`KEEP_RESULTS`] results follow it, when the
/// results between the current boundary and it that may age add up to [`BATCH_CHARS`]. Reads
/// only the events since the current boundary.
pub fn due(events: &[Event]) -> Option<usize> {
    let from = shown_from(events).max(boundary(events));
    let mut steps = 0;
    let mut results = 0;
    let mut candidate = None;
    for at in (from..events.len()).rev() {
        match &events[at] {
            Event::Known(Known::ToolFinished { .. }) => results += 1,
            Event::Known(Known::StepFinished { .. }) => {
                steps += 1;
                if steps >= KEEP_STEPS && results >= KEEP_RESULTS {
                    candidate = Some(at);
                    break;
                }
            }
            _ => {}
        }
    }
    let candidate = candidate?;
    let chars: usize = events[from..candidate]
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::ToolFinished {
                name,
                content,
                is_error,
                images,
                ..
            }) if may_age(name, content, *is_error, !images.is_empty()) => Some(content.len()),
            _ => None,
        })
        .sum();
    (chars >= BATCH_CHARS).then_some(candidate)
}

/// What the model reads in place of an aged result: the tool, what it was called with, its
/// size, and how to read it again word for word (`seq` is its position for `history_read`).
pub fn stub(name: &str, arguments: &Value, content: &str, seq: u64) -> String {
    format!(
        "[Aged out to keep this conversation's prompt small: {name} returned {} characters \
         here, called with {}. Read it again word for word with history_read \
         {{\"from\": {seq}, \"count\": 1}}, find it with history_search, or call the tool again \
         for a fresh copy.]",
        content.chars().count(),
        crate::compaction::brief(arguments),
    )
}

/// The tool a stub points at to read a result again; a conversation not offered it ages nothing.
pub const READ_BACK: &str = "history_read";

/// The length an aged result counts for when sizing what a compaction keeps.
pub const STUB_CHARS: usize = 400;

#[cfg(test)]
mod tests;
