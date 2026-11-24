//! Reactions (docs/chat-core.md, Messages, ids and replies): an emoji the person or the bot puts
//! on a message instead of words. One per side per message; a later one replaces the earlier and
//! a removed one takes it back. Pure: the engine stores what these rules decide.

use crate::chat_markup::{self, Kind};
use crate::event::{Event, Known, ReactionBy};

/// The longest emoji a reaction takes, in bytes: enough for a joined or flagged emoji.
pub const EMOJI_BYTES: usize = 16;
/// The most reactions one note to the model lists; older ones in the same note are left out.
pub const NOTED: usize = 10;

/// Whether `emoji` can be a reaction: not empty, at most [`EMOJI_BYTES`], no spaces or control
/// characters.
pub fn fits(emoji: &str) -> bool {
    !emoji.is_empty()
        && emoji.len() <= EMOJI_BYTES
        && !emoji.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The reaction `by` has on `message` now, if any.
pub fn standing<'a>(events: &'a [Event], message: &str, by: ReactionBy) -> Option<&'a str> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::Reaction {
            message: on,
            emoji,
            by: who,
            removed,
        }) if on == message && *who == by => Some((!removed).then_some(emoji.as_str())),
        _ => None,
    })?
}

/// A reaction `by` puts on `message`.
pub fn reacted(message: &str, emoji: &str, by: ReactionBy) -> Event {
    Event::Known(Known::Reaction {
        message: message.to_owned(),
        emoji: emoji.to_owned(),
        by,
        removed: false,
    })
}

/// `by` takes back their reaction on `message`; it names the emoji taken back, if there was one.
pub fn taken_back(events: &[Event], message: &str, by: ReactionBy) -> Event {
    Event::Known(Known::Reaction {
        message: message.to_owned(),
        emoji: standing(events, message, by).unwrap_or_default().to_owned(),
        by,
        removed: true,
    })
}

/// The reactions in a bot's words, as `(message, emoji)`: each `<react>` whose emoji fits, the
/// last one for a message replacing earlier ones, in the order they were written.
pub fn in_words(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for segment in chat_markup::parse(text) {
        let (Kind::React, Some(to)) = (segment.kind, segment.to) else {
            continue;
        };
        if !fits(&segment.text) {
            continue;
        }
        out.retain(|(on, _)| *on != to);
        out.push((to, segment.text));
    }
    out
}

/// The person's reactions since the model last read, gathered into one note: each message's
/// latest, a take-back of one the model never saw dropped with it, the last [`NOTED`] kept.
#[derive(Debug, Default)]
pub struct Notes {
    /// `(message, emoji)`; no emoji for a take-back.
    pending: Vec<(String, Option<String>)>,
}

impl Notes {
    /// Takes `event` in when it is a reaction, answering whether it was. The bot's own are
    /// already in its words, so they add nothing.
    pub fn add(&mut self, event: &Known) -> bool {
        let Known::Reaction {
            message,
            emoji,
            by,
            removed,
        } = event
        else {
            return false;
        };
        if *by != ReactionBy::Person {
            return true;
        }
        let unseen = self.pending.iter().position(|(on, _)| on == message);
        let earlier = unseen.map(|at| self.pending.remove(at));
        match (removed, earlier) {
            // Put and taken back before the model read it: nothing to tell.
            (true, Some((_, Some(_)))) => {}
            (true, _) => self.pending.push((message.clone(), None)),
            (false, _) => self.pending.push((message.clone(), Some(emoji.clone()))),
        }
        true
    }

    /// The note for what was added since the last one, one line each; `None` when there is none.
    pub fn take(&mut self) -> Option<String> {
        let pending = std::mem::take(&mut self.pending);
        let from = pending.len().saturating_sub(NOTED);
        let lines: Vec<String> = pending[from..]
            .iter()
            .map(|(message, emoji)| match emoji {
                Some(emoji) => format!("[the person reacted {emoji} to {message}]"),
                None => format!("[the person took back their reaction to {message}]"),
            })
            .collect();
        (!lines.is_empty()).then(|| lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_emoji_fits_when_short_and_without_spaces_or_control_characters() {
        for emoji in ["👍", "❤️", "👩‍💻", "🇳🇵", "ok"] {
            assert!(fits(emoji), "{emoji}");
        }
        for emoji in ["", "👍 ", "a\tb", "\u{7}", "👍👍👍👍👍"] {
            assert!(!fits(emoji), "{emoji:?}");
        }
    }

    #[test]
    fn the_standing_reaction_is_the_latest_and_a_take_back_clears_it() {
        let mut events = vec![reacted("m3", "👍", ReactionBy::Person)];
        events.push(reacted("m3", "🎉", ReactionBy::Bot));
        assert_eq!(standing(&events, "m3", ReactionBy::Person), Some("👍"));
        events.push(reacted("m3", "❤️", ReactionBy::Person));
        assert_eq!(standing(&events, "m3", ReactionBy::Person), Some("❤️"));
        assert_eq!(standing(&events, "m3", ReactionBy::Bot), Some("🎉"));
        let back = taken_back(&events, "m3", ReactionBy::Person);
        assert_eq!(
            back.to_json(),
            serde_json::json!({"type": "reaction", "message": "m3", "emoji": "❤️", "by": "person", "removed": true})
        );
        events.push(back);
        assert_eq!(standing(&events, "m3", ReactionBy::Person), None);
        assert_eq!(standing(&events, "m4", ReactionBy::Person), None);
    }

    #[test]
    fn a_bots_words_react_once_per_message_with_emoji_that_fit() {
        let text = "<react to=\"m2\">👍</react><msg>Done.</msg>\
                    <react to=\"m4\">too long for one</react><react to=\"m2\">🎉</react>";
        assert_eq!(in_words(text), vec![("m2".to_owned(), "🎉".to_owned())]);
        assert!(in_words("No reactions.").is_empty());
    }

    fn note(events: &[Event]) -> Option<String> {
        let mut notes = Notes::default();
        for event in events {
            if let Event::Known(known) = event {
                notes.add(known);
            }
        }
        notes.take()
    }

    #[test]
    fn the_note_tells_each_messages_latest_reaction_and_skips_the_bots() {
        let events = [
            reacted("m3", "👍", ReactionBy::Person),
            reacted("m5", "🎉", ReactionBy::Bot),
            reacted("m4", "😂", ReactionBy::Person),
            reacted("m3", "❤️", ReactionBy::Person),
        ];
        assert_eq!(
            note(&events).as_deref(),
            Some("[the person reacted 😂 to m4]\n[the person reacted ❤️ to m3]")
        );
        assert_eq!(note(&events[1..2]), None);
    }

    #[test]
    fn a_take_back_is_told_unless_the_reaction_was_never_seen() {
        let unseen = [
            reacted("m3", "👍", ReactionBy::Person),
            taken_back(&[], "m3", ReactionBy::Person),
        ];
        assert_eq!(note(&unseen), None);
        assert_eq!(
            note(&unseen[1..]).as_deref(),
            Some("[the person took back their reaction to m3]")
        );
    }

    #[test]
    fn the_note_keeps_only_the_latest_ten() {
        let events: Vec<Event> = (1..=12)
            .map(|n| reacted(&format!("m{n}"), "👍", ReactionBy::Person))
            .collect();
        let note = note(&events).unwrap_or_default();
        assert_eq!(note.lines().count(), NOTED);
        assert!(note.starts_with("[the person reacted 👍 to m3]"), "{note}");
        assert!(note.ends_with("to m12]"), "{note}");
    }
}
