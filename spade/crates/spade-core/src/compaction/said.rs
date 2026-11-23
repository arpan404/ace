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

/// A standing instruction is short: a pasted log or document that happens to say "never" is not
/// one.
const STANDING_CHARS: usize = 600;

/// Whether `text` reads as a standing instruction rather than a one-off request.
pub fn standing(text: &str) -> bool {
    if text.len() > STANDING_CHARS {
        return false;
    }
    let lower = text.to_lowercase();
    STANDING.iter().any(|word| lower.contains(word))
}

/// Whether the person wrote `event` themselves: a message of theirs, here or in an ace thread.
/// Never another bot's (`from_agent`, also a helper's tainted brief or a worker's), a routine's,
/// or one that came through a group, where a bot may have written it. Job results, answers and
/// notes are other events. Returns where they wrote it when not here.
fn persons(event: &Event) -> Option<(&str, Option<String>)> {
    match event {
        Event::Known(Known::UserMessage {
            text,
            from_agent: None,
            from_routine: None,
            from_group: None,
            from_thread,
            ..
        }) if !text.trim().is_empty() => Some((
            text,
            from_thread.as_ref().map(|_| "an ace thread".to_owned()),
        )),
        _ => None,
    }
}

/// The kept list after a compaction of `span` (the events from index `from` up to its cut):
/// `prior`, then each message the person wrote in the span, bounded. Returns the list and how
/// many older messages are no longer listed. A conversation the person never writes in (a
/// helper's) keeps nothing: the engine passes no span for it.
pub fn keep(span: &[Event], from: usize, prior: Vec<Said>, earlier: u64) -> (Vec<Said>, u64) {
    let mut said = prior;
    for (offset, event) in span.iter().enumerate() {
        if let Some((text, via)) = persons(event) {
            let seq = (from + offset) as u64 + 1;
            said.push(Said {
                seq,
                text: shortened(text, seq),
                via,
            });
        }
    }
    bound(said, earlier)
}

/// How a message kept only in part ends.
const PART: &str = "characters in all; history_read";

/// What the summary request says about the person's kept words: nothing when none are kept;
/// else that they are kept, naming those kept only in part and how many are not kept at all,
/// whose requirements and open requests the summary must hold itself.
pub fn kept_note(ledger: &crate::event::CarriedLedger) -> String {
    if ledger.said.is_empty() && ledger.said_earlier == 0 {
        return String::new();
    }
    let part: Vec<String> = ledger
        .said
        .iter()
        .filter(|s| s.text.contains(PART))
        .map(|s| format!("#{}", s.seq))
        .collect();
    let mut note = " The person's own messages are kept word for word beside your summary, so \
                    you need not restate them; do keep what they decided or asked you to keep \
                    doing."
        .to_owned();
    let mut cut = Vec::new();
    if !part.is_empty() {
        cut.push(format!(
            "messages {} are kept only in part",
            part.join(", ")
        ));
    }
    if ledger.said_earlier > 0 {
        cut.push(format!(
            "{} older messages are not kept at all",
            ledger.said_earlier
        ));
    }
    if !cut.is_empty() {
        note.push_str(&format!(
            " But {}: keep every requirement, constraint and unfinished request from those in \
             your summary.",
            cut.join(" and ")
        ));
    }
    note
}

fn shortened(text: &str, seq: u64) -> String {
    let count = text.chars().count();
    if count <= MESSAGE_CHARS {
        return text.to_owned();
    }
    let head: String = text.chars().take(MESSAGE_CHARS).collect();
    format!("{head}… ({count} {PART} {{\"from\": {seq}, \"count\": 1}} has the rest)")
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
    let mut out = String::from(
        "\nWhat the person said earlier, word for word (oldest first; each message quoted):\n",
    );
    if earlier > 0 {
        out.push_str(&format!(
            "({earlier} older messages are no longer listed; history_search finds them)\n"
        ));
    }
    // Each message is its own quoted block, every line marked, so no text inside one can pass
    // for the start of another or for Spade's own words.
    for message in said {
        let place = message
            .via
            .as_ref()
            .map(|via| format!(" in {via}"))
            .unwrap_or_default();
        out.push_str(&format!("[#{}] The person wrote{place}:\n", message.seq));
        for line in message.text.lines() {
            out.push_str("> ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}
