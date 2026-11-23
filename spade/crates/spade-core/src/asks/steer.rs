//! Steers (ADR 0215 §4): a message the person types while a reply runs is new direction. This
//! says which messages are steers (one fold the ledger and the prompt share), and when the first
//! step that read one left it unanswered, so Spade reminds the bot once.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::{Ledger, Reminded};
use crate::event::{Event, Known};

/// Where a conversation stands for telling a steer apart: whether a reply runs, and whether a
/// question card waits on the person's next typed message (which answers it, not steers).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Steering {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub asking: bool,
}

impl Steering {
    /// Reads one event; true when it is a message from the person that steers the running reply.
    pub fn read(&mut self, event: &Event) -> bool {
        let was_asking = self.asking;
        self.asking = crate::brain::still_asking(self.asking, event);
        match event {
            Event::Known(Known::ReplyStarted { reply, .. }) => {
                self.running = Some(reply.clone());
                self.asking = false;
                false
            }
            Event::Known(
                Known::ReplyFinished { .. }
                | Known::ReplyStopped { .. }
                | Known::ReplyFailed { .. }
                | Known::ReplyInterrupted { .. },
            ) => {
                self.running = None;
                self.asking = false;
                false
            }
            _ if crate::question::typed_by_person(event) => self.running.is_some() && !was_asking,
            _ => false,
        }
    }
}

/// The indexes of the steers among `events[from..]`. The walk starts at the last reply start or
/// end before `from`, never earlier: a waiting card always lies within its reply.
pub fn mid_turn(events: &[Event], from: usize) -> HashSet<usize> {
    let from = from.min(events.len());
    let start = events[..from].iter().rposition(|e| {
        matches!(
            e,
            Event::Known(
                Known::ReplyStarted { .. }
                    | Known::ReplyFinished { .. }
                    | Known::ReplyStopped { .. }
                    | Known::ReplyFailed { .. }
                    | Known::ReplyInterrupted { .. }
            )
        )
    });
    let mut steering = Steering::default();
    let mut out = HashSet::new();
    for (at, event) in events.iter().enumerate().skip(start.unwrap_or(0)) {
        if steering.read(event) && at >= from {
            out.insert(at);
        }
    }
    out
}

/// A steer as the model reads it: the message, wrapped as new direction.
pub fn framed(text: &str) -> String {
    format!("<steer>\n{text}\n</steer>")
}

/// A steer the ledger is watching until the first step that read it is answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watched {
    /// The message's id (`m6`).
    pub id: String,
    /// Its index among the events.
    pub at: usize,
    /// The first step that read it said something to the person; `None` until that step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said: Option<bool>,
}

/// The most steers watched at once.
pub(super) const MOST_WATCHED: usize = 20;

impl Ledger {
    /// A step finished: the decision on the steers its predecessor read has passed, and the
    /// steers this one read wait for its calls' results. A step with no calls ends the reply,
    /// where the stop check names what is still unsorted.
    pub(super) fn step_read(&mut self, seen: Option<usize>, text: &str, made_calls: bool) {
        self.watched.retain(|w| w.said.is_none());
        let said = !crate::chat_markup::plain(text).trim().is_empty();
        self.watched.retain_mut(|w| {
            if seen.is_none_or(|seen| seen > w.at) {
                w.said = Some(said);
                made_calls
            } else {
                true
            }
        });
    }

    pub(super) fn watch(&mut self, id: String, at: usize) {
        self.watched.push(Watched { id, at, said: None });
        if self.watched.len() > MOST_WATCHED {
            self.watched.remove(0);
        }
    }

    /// Whether the ask (or every part of it) from message `id` is sorted or closed.
    fn sorted(&self, id: &str) -> bool {
        !self
            .asks
            .iter()
            .any(|a| a.id.split('.').next() == Some(id) && !a.sorted)
    }
}

/// The reminder to store before the next model call of `reply`, when the step that first read a
/// steer made calls but said nothing to the person or left the steer unsorted. Once per steer.
pub fn due(ledger: &Ledger, reply: &str) -> Option<Reminded> {
    if ledger.steering.running.as_deref() != Some(reply) {
        return None;
    }
    let unanswered: Vec<&Watched> = ledger
        .watched
        .iter()
        .filter(|w| w.said.is_some_and(|said| !said || !ledger.sorted(&w.id)))
        .collect();
    if unanswered.is_empty() {
        return None;
    }
    let lines: Vec<String> = unanswered
        .iter()
        .map(|w| match ledger.asks.iter().find(|a| a.id == w.id) {
            Some(ask) => format!("- {}: {}", w.id, super::block::quoted(&ask.words)),
            None => format!("- {}", w.id),
        })
        .collect();
    let note = format!(
        "<steer_unanswered from=\"spade\">\nThe person wrote while you worked, and you haven't \
         answered yet:\n{}\nBefore more work, tell them in a line what changes, and sort it with \
         the asks tool (a steer that stops or replaces earlier work drops or changes those \
         asks).\n</steer_unanswered>",
        lines.join("\n")
    );
    Some(Reminded {
        reply: reply.to_owned(),
        steers: unanswered.iter().map(|w| w.id.clone()).collect(),
        note,
    })
}
