//! Memory decisions (ADR 0128, docs/memory.md): how a note's text is cleaned, what a search looks
//! for, how matches rank, when two notes are the same, and what the prompt shows. Pure: the store
//! runs the queries and the engine supplies the time.

use crate::event::{Event, Known};

/// The longest note, in characters.
pub const NOTE_CHARS: usize = 500;
/// The most notes one scope holds.
pub const MOST_NOTES: usize = 1_000;
/// The most notes recalled with one message.
pub const RECALLED: usize = 5;
/// The longest index of notes in the cached top, in characters.
pub const INDEX_CHARS: usize = 3_000;

const DAY_MS: f64 = 86_400_000.0;

/// Who wrote a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Person,
    Bot,
    Compaction,
}

impl Source {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Bot => "bot",
            Self::Compaction => "compaction",
        }
    }

    /// Read leniently: anything unknown counts as the bot's.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "person" => Self::Person,
            "compaction" => Self::Compaction,
            _ => Self::Bot,
        }
    }
}

/// A note as the ranking and the prompt need it.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub id: String,
    pub text: String,
    /// Visible to every bot ("About you").
    pub shared: bool,
    pub updated_ms: i64,
    pub used_ms: Option<i64>,
    pub uses: u32,
}

/// A note's text as stored: trimmed, on one line, at most [`NOTE_CHARS`]. `None` when nothing is
/// left or it is too long.
pub fn clean(text: &str) -> Option<String> {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = one_line.chars().count();
    (count > 0 && count <= NOTE_CHARS).then_some(one_line)
}

const COMMON: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "your", "all", "any", "can", "had", "her",
    "was", "one", "our", "out", "has", "his", "how", "its", "may", "who", "did", "get", "got",
    "let", "say", "she", "too", "use", "that", "this", "with", "have", "from", "they", "will",
    "would", "there", "their", "what", "about", "which", "when", "make", "like", "just", "into",
    "than", "then", "them", "these", "some", "could", "should", "please", "want", "need", "also",
];

/// The words a search looks for: three letters or more, lower case, common words left out, each
/// once, in order.
pub fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        let word = word.to_lowercase();
        if word.chars().count() >= 3 && !COMMON.contains(&word.as_str()) && !out.contains(&word) {
            out.push(word);
        }
    }
    out
}

/// An FTS5 query matching any of the text's words, each quoted so nothing in it is read as
/// syntax. `None` when there is nothing to look for.
pub fn match_query(text: &str) -> Option<String> {
    let words = words(text);
    (!words.is_empty()).then(|| {
        words
            .iter()
            .take(24)
            .map(|w| format!("\"{}\"", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

/// A match's final score, higher first: keyword relevance (BM25 as FTS5 reports it, where lower
/// is better), weighted up for notes used often and down with age since last used or changed.
pub fn score(bm25: f64, note: &Note, now_ms: i64) -> f64 {
    let relevance = (-bm25).max(1e-6);
    let last = note.used_ms.unwrap_or(note.updated_ms).max(note.updated_ms);
    let days = ((now_ms - last).max(0) as f64) / DAY_MS;
    let recency = 1.0 / (1.0 + days / 30.0);
    let usage = 1.0 + f64::from(note.uses).ln_1p() / 4.0;
    relevance * recency * usage
}

/// Matches with their BM25, best first by [`score`], ties by id.
pub fn rank(mut matches: Vec<(Note, f64)>, now_ms: i64) -> Vec<Note> {
    let mut scored: Vec<(f64, Note)> = matches
        .drain(..)
        .map(|(note, bm25)| (score(bm25, &note, now_ms), note))
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    scored.into_iter().map(|(_, note)| note).collect()
}

/// Whether `a` and `b` say the same: the same words, or nearly all the same (four in five of the
/// longer note's words are in the other).
pub fn same(a: &str, b: &str) -> bool {
    let wa = all_words(a);
    let wb = all_words(b);
    if wa.is_empty() || wb.is_empty() {
        return a.trim().eq_ignore_ascii_case(b.trim());
    }
    let shared = wa.iter().filter(|w| wb.contains(w)).count();
    let longer = wa.len().max(wb.len());
    shared * 5 >= longer * 4
}

fn all_words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        let word = word.to_lowercase();
        if !word.is_empty() && !out.contains(&word) {
            out.push(word);
        }
    }
    out
}

/// The index of notes for the cached top: shared notes first, then the bot's own, in the order
/// given (most used and most recent first), as many whole lines as fit in [`INDEX_CHARS`]. Empty
/// with no notes.
pub fn index(notes: &[Note]) -> String {
    let mut lines = String::new();
    for shared in [true, false] {
        for note in notes.iter().filter(|n| n.shared == shared) {
            let line = format!("- [{}] {}{}\n", note.id, about(note), note.text);
            if lines.len() + line.len() > INDEX_CHARS {
                break;
            }
            lines.push_str(&line);
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "Notes you keep (from earlier conversations; the person can see and edit them). Use \
memory_search for more, and memory_save, memory_update and memory_forget to keep them right:\n\
<memory>\n{lines}</memory>"
    )
}

fn about(note: &Note) -> &'static str {
    if note.shared {
        "(about the person) "
    } else {
        ""
    }
}

/// The notes recalled with a message, as its per-turn context. Empty with none.
pub fn recall(notes: &[Note]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut out = String::from("Notes that may matter here:\n");
    for note in notes {
        out.push_str(&format!("- [{}] {}{}\n", note.id, about(note), note.text));
    }
    out.trim_end().to_owned()
}

/// Note ids the prompt already shows: those in the latest index, and in messages' context since
/// the last compaction. Recall leaves them out.
pub fn shown(events: &[Event]) -> Vec<String> {
    let cut = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ContextCompacted { .. })));
    let keep_from = cut.and_then(|at| match &events[at] {
        Event::Known(Known::ContextCompacted { keep_from, .. }) => Some(*keep_from),
        _ => None,
    });
    let mut ids = Vec::new();
    if let Some(text) = latest_index(events) {
        ids.extend(ids_in(text));
    }
    for event in &events[keep_from.unwrap_or(0).min(events.len())..] {
        if let Event::Known(Known::UserMessage {
            context: Some(context),
            ..
        }) = event
        {
            ids.extend(ids_in(context));
        }
    }
    ids
}

/// The latest `memory_indexed` text.
pub fn latest_index(events: &[Event]) -> Option<&str> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::MemoryIndexed { text }) => Some(text.as_str()),
        _ => None,
    })
}

/// Whether the index may be (re)written now: the conversation has had no model call and no index
/// since it began or last compacted, so the cached top is still free to take one. Afterwards it
/// stays as it is until the next compaction.
pub fn index_due(events: &[Event]) -> bool {
    let from = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ContextCompacted { .. })))
        .map_or(0, |at| at + 1);
    !events[from..].iter().any(|e| {
        matches!(
            e,
            Event::Known(Known::StepFinished { .. } | Known::MemoryIndexed { .. })
        )
    })
}

/// The words of an event worth finding again with `history_search`, labelled with who wrote
/// them: the person's (or another bot's) messages, the bot's own text, tool and job results.
/// `None` for everything else.
pub fn searchable(event: &Event) -> Option<String> {
    let Event::Known(known) = event else {
        return None;
    };
    let text = match known {
        Known::UserMessage {
            text, from_agent, ..
        } => match from_agent {
            Some(from) => format!("{} (bot): {text}", from.name),
            None => format!("person: {text}"),
        },
        Known::StepFinished { text, .. } => format!("you: {text}"),
        Known::ToolFinished { name, content, .. } => format!("{name} result: {content}"),
        Known::JobFinished { name, content, .. } => format!("{name} job result: {content}"),
        Known::QuestionAsked { question, .. } => format!("you asked: {question}"),
        _ => return None,
    };
    let body = text.split_once(": ").map_or("", |(_, body)| body);
    (!body.trim().is_empty()).then_some(text)
}

/// Note ids written as `[n_…]` in `text`.
fn ids_in(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("[n_") {
        let after = &rest[at + 1..];
        match after.find(']') {
            Some(end) => {
                out.push(after[..end].to_owned());
                rest = &after[end..];
            }
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, text: &str, updated_ms: i64, uses: u32) -> Note {
        Note {
            id: id.into(),
            text: text.into(),
            shared: false,
            updated_ms,
            used_ms: None,
            uses,
        }
    }

    #[test]
    fn a_note_is_kept_on_one_line_and_bounded() {
        assert_eq!(
            clean("  Prefers\nwindow   seats "),
            Some("Prefers window seats".into())
        );
        assert_eq!(clean("   "), None);
        assert_eq!(clean(&"a".repeat(NOTE_CHARS + 1)), None);
    }

    #[test]
    fn a_search_looks_for_meaningful_words_quoted_so_none_is_syntax() {
        assert_eq!(
            match_query("Book the flight AND a \"window\" seat, please"),
            Some("\"book\" OR \"flight\" OR \"window\" OR \"seat\"".into())
        );
        assert_eq!(match_query("is it ok?"), None);
    }

    #[test]
    fn an_equally_relevant_note_used_often_and_lately_ranks_first() {
        let now = 100 * DAY_MS as i64;
        let stale = note("n_1", "window seats", 0, 0);
        let fresh = note("n_2", "window seats", now, 3);
        let ranked = rank(vec![(stale, -2.0), (fresh, -2.0)], now);
        assert_eq!(ranked[0].id, "n_2");
        // Relevance still wins over a small recency edge.
        let relevant = note("n_3", "aisle", now - DAY_MS as i64, 0);
        let barely = note("n_4", "aisle", now, 0);
        let ranked = rank(vec![(barely, -0.5), (relevant, -5.0)], now);
        assert_eq!(ranked[0].id, "n_3");
    }

    #[test]
    fn notes_with_nearly_all_the_same_words_are_the_same() {
        assert!(same("Prefers window seats", "prefers window seats."));
        assert!(same(
            "The person prefers window seats on long flights",
            "The person prefers window seats on all long flights"
        ));
        assert!(!same("Prefers window seats", "Prefers aisle seats"));
    }

    #[test]
    fn the_index_lists_shared_notes_first_and_stays_within_its_bound() {
        let mut shared = note("n_2", "Name is Ari", 0, 0);
        shared.shared = true;
        let own = note("n_1", "Uses metric units", 0, 0);
        let text = index(&[own.clone(), shared]);
        let ari = text.find("[n_2] (about the person) Name is Ari");
        let metric = text.find("[n_1] Uses metric units");
        assert!(ari.is_some() && metric.is_some() && ari < metric, "{text}");
        assert_eq!(index(&[]), "");
        let many: Vec<Note> = (0..200)
            .map(|i| note(&format!("n_{i}"), &"x".repeat(100), 0, 0))
            .collect();
        assert!(index(&many).len() < INDEX_CHARS + 300);
    }

    #[test]
    fn notes_already_shown_since_the_last_compaction_are_known() {
        let with = |context: &str| {
            Event::Known(Known::UserMessage {
                text: "hi".into(),
                context: Some(context.into()),
                images: Vec::new(),
                from_agent: None,
            })
        };
        let events = vec![
            with("- [n_1] old"),
            Event::Known(Known::ContextCompacted {
                summary: "s".into(),
                keep_from: 2,
                tokens_before: 0,
                images_left_out: None,
            }),
            with("- [n_2] kept"),
            Event::Known(Known::MemoryIndexed {
                text: "- [n_3] indexed".into(),
            }),
        ];
        assert_eq!(shown(&events), vec!["n_3", "n_2"]);
        assert!(!index_due(&events));
        assert!(index_due(&events[..3]));
        assert!(index_due(&[]));
    }
}
