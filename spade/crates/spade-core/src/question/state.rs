//! Where each question of a conversation stands, folded from its events, so it survives
//! restarts: what the card shows, and how many are left for later.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Question, asked, typed_by_person};
use crate::event::{Event, Known};

/// Where a question stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Standing {
    /// The turn is paused on it.
    Waiting,
    /// Left for later (by the person, or asked with `wait: false`); answerable any time.
    Deferred,
    Answered,
    Dismissed,
    /// Its turn ended (Stop, a failure) before it was answered.
    Closed,
}

/// One question card, as the conversation's events leave it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    pub call_id: String,
    pub reply: String,
    pub questions: Vec<Question>,
    pub standing: Standing,
    /// Asked with `wait: false`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub asked_for_later: bool,
    /// The answers, when it was answered in the card or by a message that could stand for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<Value>>,
    /// It was answered by a message the person typed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub typed: bool,
}

/// Every question card in the conversation, oldest first.
pub fn views<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<View> {
    let mut cards: Vec<View> = Vec::new();
    for event in events {
        if typed_by_person(event) {
            // An app's form is answered only on its card (ADR 0202 §2).
            for card in cards
                .iter_mut()
                .filter(|c| c.standing == Standing::Waiting && !is_form(&c.call_id))
            {
                card.standing = Standing::Answered;
                card.typed = true;
            }
            continue;
        }
        let Event::Known(known) = event else { continue };
        match known {
            Known::QuestionAsked {
                reply,
                call_id,
                question,
                questions,
                ..
            } => cards.push(View {
                call_id: call_id.clone(),
                reply: reply.clone(),
                questions: asked(question, questions),
                standing: Standing::Waiting,
                asked_for_later: false,
                answers: None,
                typed: false,
            }),
            Known::QuestionDeferred { call_id, by_bot } => {
                if let Some(card) = card(&mut cards, call_id, &[Standing::Waiting]) {
                    card.standing = Standing::Deferred;
                    card.asked_for_later = *by_bot;
                }
            }
            Known::QuestionAnswered {
                call_id,
                answers,
                typed,
                ..
            } => {
                let open = [Standing::Waiting, Standing::Deferred];
                if let Some(card) = card(&mut cards, call_id, &open) {
                    card.standing = Standing::Answered;
                    card.answers = Some(answers.clone());
                } else if *typed
                    && let Some(card) = card(&mut cards, call_id, &[Standing::Answered])
                    && card.answers.is_none()
                {
                    // The message stored just before it answered the card; these are the answers
                    // it stood for.
                    card.answers = Some(answers.clone());
                }
            }
            Known::QuestionDismissed { call_id, .. } => {
                let open = [Standing::Waiting, Standing::Deferred];
                if let Some(card) = card(&mut cards, call_id, &open) {
                    card.standing = Standing::Dismissed;
                }
            }
            Known::ToolFinished { call_id, .. } => {
                if let Some(card) = card(&mut cards, call_id, &[Standing::Waiting]) {
                    card.standing = Standing::Closed;
                }
                // The forms its app showed during the call close with it.
                for card in cards.iter_mut().filter(|c| {
                    c.standing == Standing::Waiting
                        && super::elicit::call_of(&c.call_id) == Some(call_id.as_str())
                }) {
                    card.standing = Standing::Closed;
                }
            }
            Known::StopRequested {
                reply: Some(reply), ..
            }
            | Known::ReplyFinished { reply, .. }
            | Known::ReplyStopped { reply, .. }
            | Known::ReplyFailed { reply, .. }
            | Known::ReplyInterrupted { reply, .. } => {
                for card in cards
                    .iter_mut()
                    .filter(|c| c.standing == Standing::Waiting && &c.reply == reply)
                {
                    card.standing = Standing::Closed;
                }
            }
            _ => {}
        }
    }
    cards
}

/// The cards still open (waiting, or left for later), kept event by event by the rules of
/// [`views`], so a caller that only asks whether one is open reads each event once instead of
/// walking the history (the stop check, ADR 0215).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct OpenCards(Vec<OpenCard>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct OpenCard {
    call_id: String,
    reply: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    deferred: bool,
}

impl OpenCards {
    /// Whether a card waits on the person, or was left for later.
    pub fn any(&self) -> bool {
        !self.0.is_empty()
    }

    pub fn read(&mut self, event: &Event) {
        if typed_by_person(event) {
            self.0.retain(|c| c.deferred || is_form(&c.call_id));
            return;
        }
        let Event::Known(known) = event else { return };
        let last = |cards: &[OpenCard], id: &str, waiting_only: bool| {
            cards
                .iter()
                .rposition(|c| c.call_id == id && !(waiting_only && c.deferred))
        };
        match known {
            Known::QuestionAsked { reply, call_id, .. } => self.0.push(OpenCard {
                call_id: call_id.clone(),
                reply: reply.clone(),
                deferred: false,
            }),
            Known::QuestionDeferred { call_id, .. } => {
                if let Some(at) = last(&self.0, call_id, true) {
                    self.0[at].deferred = true;
                }
            }
            Known::QuestionAnswered { call_id, .. } | Known::QuestionDismissed { call_id, .. } => {
                if let Some(at) = last(&self.0, call_id, false) {
                    self.0.remove(at);
                }
            }
            Known::ToolFinished { call_id, .. } => {
                if let Some(at) = last(&self.0, call_id, true) {
                    self.0.remove(at);
                }
                self.0.retain(|c| {
                    c.deferred || super::elicit::call_of(&c.call_id) != Some(call_id.as_str())
                });
            }
            Known::StopRequested {
                reply: Some(reply), ..
            }
            | Known::ReplyFinished { reply, .. }
            | Known::ReplyStopped { reply, .. }
            | Known::ReplyFailed { reply, .. }
            | Known::ReplyInterrupted { reply, .. } => {
                self.0.retain(|c| c.deferred || &c.reply != reply);
            }
            _ => {}
        }
    }
}

/// Whether the card is an app's form, which only an answer on it answers.
fn is_form(card_id: &str) -> bool {
    super::elicit::call_of(card_id).is_some()
}

fn card<'a>(cards: &'a mut [View], call_id: &str, from: &[Standing]) -> Option<&'a mut View> {
    cards
        .iter_mut()
        .rev()
        .find(|c| c.call_id == call_id && from.contains(&c.standing))
}

/// Where `call_id`'s question stands, if it asked one.
pub fn standing<'a>(
    events: impl IntoIterator<Item = &'a Event>,
    call_id: &str,
) -> Option<Standing> {
    views(events)
        .into_iter()
        .rev()
        .find(|c| c.call_id == call_id)
        .map(|c| c.standing)
}

/// How many questions are left for later: every question of each card deferred and not yet
/// answered or dismissed, so a card of two counts two.
pub fn for_later<'a>(events: impl IntoIterator<Item = &'a Event>) -> usize {
    views(events)
        .iter()
        .filter(|c| c.standing == Standing::Deferred)
        .map(|c| c.questions.len())
        .sum()
}
