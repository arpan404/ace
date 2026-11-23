//! The person's own messages a compaction keeps word for word (ADR 0216), so a summary can never
//! lose what they asked for. Carried forward from compaction to compaction like the "already
//! carried out" list; bounded by [`SAID_CHARS`], dropping the oldest messages first but keeping
//! standing instructions ("always…", "never…", "from now on…") longest.

use crate::event::{Event, Known, Said};

/// The most text the kept messages take in a summary.
pub const SAID_CHARS: usize = 24_000;
/// A longer message (a pasted log, say) keeps its start, with a note of where the rest is.
pub const MESSAGE_CHARS: usize = 3_000;

/// Words that mark a message as a standing instruction, kept longest when the list is full.
const STANDING: [&str; 12] = [
    "always",
    "never",
    "from now on",
    "don't",
    "do not",
    "remember",
    "make sure",
    "every time",
    "whenever",
    "stop ",
    "going forward",
    "instead of",
];

/// Whether `text` reads as a standing instruction rather than a one-off request.
pub fn standing(text: &str) -> bool {
    let lower = text.to_lowercase();
    STANDING.iter().any(|word| lower.contains(word))
}

/// The kept list after a compaction of `span` (the events from index `from` up to its cut):
/// `prior`, then each message the person sent in the span, bounded. Returns the list and how
/// many older messages are no longer listed.
pub fn keep(span: &[Event], from: usize, prior: Vec<Said>, earlier: u64) -> (Vec<Said>, u64) {
    let mut said = prior;
    for (offset, event) in span.iter().enumerate() {
        if let Event::Known(Known::UserMessage {
            text,
            from_agent: None,
            ..
        }) = event
            && !text.trim().is_empty()
        {
            let seq = (from + offset) as u64 + 1;
            said.push(Said {
                seq,
                text: shortened(text, seq),
            });
        }
    }
    bound(said, earlier)
}

fn shortened(text: &str, seq: u64) -> String {
    let count = text.chars().count();
    if count <= MESSAGE_CHARS {
        return text.to_owned();
    }
    let head: String = text.chars().take(MESSAGE_CHARS).collect();
    format!(
        "{head}… ({count} characters in all; history_read {{\"from\": {seq}, \"count\": 1}} has \
         the rest)"
    )
}

/// Keeps the list within [`SAID_CHARS`]: newest first, then standing instructions before
/// one-off requests, the rest folded into the count.
fn bound(said: Vec<Said>, earlier: u64) -> (Vec<Said>, u64) {
    let mut keep = vec![false; said.len()];
    let mut room = SAID_CHARS;
    // The newest message always stays; standing instructions next, newest first; then the rest.
    let order = said
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, s)| standing(&s.text))
        .chain(
            said.iter()
                .enumerate()
                .rev()
                .filter(|(_, s)| !standing(&s.text)),
        )
        .map(|(at, _)| at);
    let newest = said.len().checked_sub(1);
    for at in newest.into_iter().chain(order) {
        if keep[at] {
            continue;
        }
        let size = said[at].text.len();
        if size <= room || Some(at) == newest {
            room = room.saturating_sub(size);
            keep[at] = true;
        }
    }
    let dropped = keep.iter().filter(|k| !**k).count() as u64;
    let kept = said
        .into_iter()
        .zip(keep)
        .filter_map(|(s, keep)| keep.then_some(s))
        .collect();
    (kept, earlier + dropped)
}

/// The kept messages as the summary prints them, oldest first.
pub fn section(said: &[Said], earlier: u64) -> String {
    if said.is_empty() && earlier == 0 {
        return String::new();
    }
    let mut out = String::from("\nWhat the person said earlier, word for word (oldest first):\n");
    if earlier > 0 {
        out.push_str(&format!(
            "- ({earlier} older messages are no longer listed; history_search finds them)\n"
        ));
    }
    for message in said {
        out.push_str(&format!(
            "- [#{}] {}\n",
            message.seq,
            message.text.replace('\n', "\n  ")
        ));
    }
    out
}
