//! The person's asks (ADR 0215): a ledger the harness keeps of what the person asked, folded
//! from stored events, so every model call can be reminded of it however long the conversation.
//! Each message from the person opens an ask; the bot sorts and closes them with the `asks` tool
//! (`change`), the prompt ends with a short block from the ledger (`block`), and a reply that
//! would end with an ask open gets one more step first (`check`).
//!
//! The fold is incremental: a ledger knows how many events it has read (`through`) and reads only
//! the ones after; each compaction stores the ledger as it stood, so a fresh fold starts there.
//!
//! The public surface, which other harness work builds on (ADR 0215, "The ledger's surface"):
//! [`Ledger::of`] and [`Ledger::advance`]; what it holds ([`Ledger::asks`], [`Ledger::standing`],
//! [`Ledger::earlier`], [`Ledger::through`], [`Ledger::open_asks`], [`Ledger::ask`]);
//! [`change::decide`]; [`block::text`] and [`block::appended`]; [`check::due`] and
//! [`check::settled`]; [`steer::due`] and [`steer::mid_turn`]. The rest of the ledger is the
//! fold's own bookkeeping, kept crate-private.

pub mod block;
pub mod change;
pub mod check;
pub mod steer;

use serde::{Deserialize, Serialize};

use crate::event::{Event, Known};

/// The tool the bot sorts and closes asks with.
pub const ASKS: &str = "asks";

/// The most of a message's words an ask keeps.
pub const WORDS_CHARS: usize = 300;

/// The most open or waiting asks kept; past this the oldest fold into [`Ledger::earlier`].
pub const MOST_ASKS: usize = 40;

/// The most standing instructions kept; one more is refused until one is lifted.
pub const MOST_STANDING: usize = 20;

/// The most events a fresh fold reads back for a stored ledger, and from where it starts when
/// none is there (ADR 0170): asks older than that, in a conversation from before the ledger, are
/// taken as settled by the conversation itself.
pub const LOOK_BACK: usize = 2_000;

/// How many events a ledger reads before Spade stores a copy of it (`asks_noted`), so a fold
/// after a restart reads at most this many.
pub const NOTE_EVERY: usize = 500;

/// What the person asked that is still open or waiting, and what stays in force.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Ledger {
    /// How many of the conversation's events this ledger has read.
    pub through: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<Ask>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub standing: Vec<Standing>,
    /// Older open asks no longer kept one by one, so the ledger stays bounded.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub earlier: u32,
    /// The standing instructions recorded so far, for the next one's id.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) standing_made: u32,
    /// Whether a reply runs where the fold stopped, so a message then is a steer.
    #[serde(default)]
    pub(crate) steering: steer::Steering,
    /// Steers whose first answering step is still to be judged (§4).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) watched: Vec<steer::Watched>,
    /// The latest reply the stop check ran in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) checked: Option<String>,
    /// The question cards still open, so the stop check never walks the history.
    #[serde(default)]
    pub(crate) cards: crate::question::OpenCards,
    /// Where the latest stored copy of the ledger stands (`asks_noted`, a compaction's).
    #[serde(default, skip_serializing_if = "is_none_usize")]
    pub(crate) stored: usize,
}

/// One thing the person asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    /// The message's id (`m12`), or a part of it (`m12.2`) once split.
    pub id: String,
    /// The person's words, cut to [`WORDS_CHARS`]; or the bot's wording once changed or split.
    pub words: String,
    #[serde(default)]
    pub state: State,
    /// It arrived while a reply was running.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub steer: bool,
    /// The bot has sorted it with `asks` at least once.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sorted: bool,
    /// A stop check named it already, so it isn't named again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named: bool,
}

/// Where an ask stands while it is kept; closed asks leave the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    #[default]
    Open,
    Waiting(On),
}

/// What a waiting ask waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum On {
    Person,
    Job,
    Time,
}

impl On {
    pub fn words(self) -> &'static str {
        match self {
            On::Person => "the person",
            On::Job => "a job",
            On::Time => "a time",
        }
    }
}

/// An instruction that stays in force until the person lifts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Standing {
    /// `s1`, `s2`, …
    pub id: String,
    /// The message it came from.
    pub from: String,
    pub words: String,
}

/// `asks_updated`: what one `asks` call changed, as the engine accepted it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Updated {
    pub call_id: String,
    pub changes: Vec<change::Change>,
}

/// `asks_reminded`: the first step that read these steers left them unanswered (§4); the model
/// reads `note` as Spade's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reminded {
    pub reply: String,
    pub steers: Vec<String>,
    pub note: String,
}

/// `asks_checked`: the stop check ran in `reply`, naming `asks`; the model reads `note` as
/// Spade's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checked {
    pub reply: String,
    pub asks: Vec<String>,
    pub note: String,
}

/// The maker of a worker bot (ADR 0161), named by its conversation's first event.
pub(crate) fn maker_of(events: &[Event]) -> Option<&str> {
    match events.first() {
        Some(Event::Known(Known::WorkerOf(link))) => Some(&link.parent),
        _ => None,
    }
}

/// Whether `event` is a message from the person: typed by them, or for a worker sent by its
/// maker. The one rule for what opens an ask and what steers.
pub(crate) fn is_persons(event: &Event, maker: Option<&str>) -> bool {
    let Event::Known(Known::UserMessage {
        from_agent,
        from_routine: None,
        from_group: None,
        ..
    }) = event
    else {
        return false;
    };
    match from_agent {
        None => true,
        Some(from) => maker == Some(from.id.as_str()) && from.contract.is_none(),
    }
}

impl Ledger {
    /// The ledger of `events`: from the latest stored copy (`asks_noted`, or a compaction's)
    /// among the last [`LOOK_BACK`] events, then the events after it. With none there it reads
    /// only those last events: older asks of a conversation from before the ledger are taken as
    /// settled.
    pub fn of(events: &[Event]) -> Self {
        let floor = events.len().saturating_sub(LOOK_BACK);
        let stored = events[floor..].iter().rev().find_map(|event| match event {
            Event::Known(Known::ContextCompacted {
                asks: Some(stored), ..
            })
            | Event::Known(Known::AsksNoted(stored)) => Some(stored),
            _ => None,
        });
        let mut ledger = match stored {
            Some(stored) if stored.through <= events.len() => (**stored).clone(),
            _ => Self {
                through: floor,
                stored: floor,
                ..Self::default()
            },
        };
        ledger.advance(events);
        ledger
    }

    /// A copy to store as `asks_noted` once this ledger has read [`NOTE_EVERY`] events since the
    /// last stored one; `None` before.
    pub fn note_due(&self) -> Option<Self> {
        (self.through >= self.stored + NOTE_EVERY).then(|| Self {
            stored: self.through,
            ..self.clone()
        })
    }

    /// Reads the events stored since this ledger was last advanced: `events[self.through..]`,
    /// never the ones before.
    pub fn advance(&mut self, events: &[Event]) {
        let from = self.through.min(events.len());
        let maker = maker_of(events);
        for (at, event) in events.iter().enumerate().skip(from) {
            let steer = self.steering.read(event, maker);
            self.cards.read(event);
            let persons = is_persons(event, maker);
            if let Event::Known(known) = event {
                self.read(at, known, steer, persons);
            }
        }
        self.through = events.len().max(self.through);
    }

    fn read(&mut self, at: usize, event: &Known, steer: bool, persons: bool) {
        match event {
            Known::ContextCompacted { asks: Some(_), .. } | Known::AsksNoted(_) => {
                self.stored = at;
            }
            Known::ReplyFinished { .. }
            | Known::ReplyStopped { .. }
            | Known::ReplyFailed { .. }
            | Known::ReplyInterrupted { .. } => self.watched.clear(),
            Known::StepFinished {
                seen, text, calls, ..
            } => self.step_read(*seen, text, !calls.is_empty()),
            Known::AsksReminded(reminded) => {
                self.watched.retain(|w| !reminded.steers.contains(&w.id));
            }
            Known::AsksUpdated(updated) => {
                for one in &updated.changes {
                    self.apply(one);
                }
            }
            Known::AsksChecked(checked) => {
                self.checked = Some(checked.reply.clone());
                for ask in self.asks.iter_mut() {
                    if checked.asks.contains(&ask.id) {
                        ask.named = true;
                    }
                }
            }
            Known::UserMessage { .. } if persons => {
                if let Some(words) = words_of(event) {
                    let id = crate::chat_markup::id(at as u64 + 1, 0);
                    if steer {
                        self.watch(id.clone(), at);
                    }
                    self.open(Ask {
                        id,
                        words,
                        state: State::Open,
                        steer,
                        sorted: false,
                        named: false,
                    });
                }
            }
            _ => {}
        }
    }

    fn open(&mut self, ask: Ask) {
        self.asks.push(ask);
        while self.asks.len() > MOST_ASKS {
            self.asks.remove(0);
            self.earlier += 1;
        }
    }

    /// The asks still open (unsorted ones included), oldest first.
    pub fn open_asks(&self) -> impl Iterator<Item = &Ask> {
        self.asks.iter().filter(|a| a.state == State::Open)
    }

    pub fn ask(&self, id: &str) -> Option<&Ask> {
        self.asks.iter().find(|a| a.id == id)
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.asks.iter().position(|a| a.id == id)
    }

    fn apply(&mut self, one: &change::Change) {
        use change::Change;
        match one {
            Change::Open { ask } => self.set(ask, |a| a.state = State::Open),
            Change::Waiting { ask, on, .. } => self.set(ask, |a| a.state = State::Waiting(*on)),
            Change::Changed { ask, words, .. } => self.set(ask, |a| {
                a.words = cut(words, WORDS_CHARS);
                a.state = State::Open;
            }),
            Change::Done { ask, .. } | Change::Dropped { ask, .. } | Change::Chat { ask, .. } => {
                if let Some(at) = self.position(ask) {
                    self.asks.remove(at);
                }
            }
            Change::Split { ask, into } => {
                let Some(at) = self.position(ask) else { return };
                let whole = self.asks.remove(at);
                let parts = into.iter().enumerate().map(|(n, words)| Ask {
                    id: format!("{}.{}", whole.id, n + 1),
                    words: cut(words, WORDS_CHARS),
                    state: State::Open,
                    steer: whole.steer,
                    sorted: true,
                    named: false,
                });
                self.asks.splice(at..at, parts);
                while self.asks.len() > MOST_ASKS {
                    self.asks.remove(0);
                    self.earlier += 1;
                }
            }
            Change::Standing { id, from, words } => {
                self.standing_made += 1;
                self.standing.push(Standing {
                    id: id.clone(),
                    from: from.clone(),
                    words: cut(words, WORDS_CHARS),
                });
            }
            Change::Lift { standing, .. } => self.standing.retain(|s| &s.id != standing),
        }
    }

    fn set(&mut self, id: &str, how: impl FnOnce(&mut Ask)) {
        if let Some(ask) = self.asks.iter_mut().find(|a| a.id == id) {
            how(ask);
            ask.sorted = true;
        }
    }
}

/// The words of a message from the person, for its ask.
fn words_of(event: &Known) -> Option<String> {
    let Known::UserMessage {
        text,
        images,
        documents,
        ..
    } = event
    else {
        return None;
    };
    let text = text.trim();
    if !text.is_empty() {
        return Some(cut(text, WORDS_CHARS));
    }
    (!images.is_empty() || !documents.is_empty()).then(|| "(sent attachments only)".to_owned())
}

fn is_none_usize(n: &usize) -> bool {
    *n == 0
}

/// `text` cut to `longest` characters, with an ellipsis when cut.
pub fn cut(text: &str, longest: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= longest {
        return text.to_owned();
    }
    let kept: String = text.chars().take(longest.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[cfg(test)]
mod tests;
