//! Looks up the message an id names, for a reply that quotes it (ADR 0212 §4).

use super::{parse, segment_plain, split_id};
use crate::event::{Event, Known, ReplyTo};

/// How much of a quoted message is kept, in characters.
pub const QUOTE_CHARS: usize = 280;

/// The message `id` names in a conversation's `events` (`events[seq - 1]` is the event with
/// `seq`), as a reply stores it; `None` when no message has that id.
pub fn quoted(events: &[Event], id: &str) -> Option<ReplyTo> {
    let (seq, index) = split_id(id)?;
    let event = events.get(usize::try_from(seq).ok()?.checked_sub(1)?)?;
    let (text, mine, name) = match event {
        Event::Known(Known::UserMessage { text, .. })
            if crate::question::typed_by_person(event) =>
        {
            (whole(text, index)?, true, None)
        }
        Event::Known(
            Known::StepFinished { text, .. }
            | Known::ReplyStopped { text, .. }
            | Known::ReplyFailed { text, .. }
            | Known::ReplyInterrupted { text, .. },
        ) => (nth(text, index)?, false, None),
        Event::Known(Known::GroupMessage {
            text, from: None, ..
        }) => (whole(text, index)?, true, None),
        Event::Known(Known::GroupMessage {
            text,
            from: Some(bot),
            ..
        }) => (nth(text, index)?, false, Some(bot.name.clone())),
        _ => return None,
    };
    Some(ReplyTo {
        id: id.to_owned(),
        text: cut(&text),
        mine,
        name,
    })
}

/// The person's words are one message: only its first id names it.
fn whole(text: &str, index: usize) -> Option<String> {
    let text = text.trim();
    (index == 0 && !text.is_empty()).then(|| text.to_owned())
}

fn nth(text: &str, index: usize) -> Option<String> {
    parse(text).get(index).map(segment_plain)
}

fn cut(text: &str) -> String {
    if text.chars().count() <= QUOTE_CHARS {
        return text.to_owned();
    }
    let kept: String = text.chars().take(QUOTE_CHARS - 1).collect();
    format!("{}…", kept.trim_end())
}
