//! An app's form mid-call (MCP elicitation, ADR 0202 §2): stored as a question card from the
//! bot, labelled with the app's name, and the person's answer on that card handed back to the
//! call that waits on it, once. The card's rules are `spade_core::question::elicit`.
//!
//! Only the running call holds the way back to its app, so a card is answerable only while that
//! call waits: one whose call ended (or that Spade restarted under) closes when answered, and
//! the call's own result, stored as it ends, closes it in the fold.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use spade_core::event::{Event, Known};
use spade_core::question::{self, Question, Standing, elicit};
use tokio::sync::oneshot;

use super::Engine;
use super::questions::{QuestionError, QuestionReply};

/// What the person did with a form's card.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Given {
    /// Their answers, checked against the card's questions.
    Answers(Vec<Value>),
    /// Never mind.
    Declined,
    /// Answer later: the app can't wait for it, so it reads that they didn't choose.
    Cancelled,
}

/// The forms waiting on the person, and the calls whose app asked for a secret.
#[derive(Default)]
pub(crate) struct Open {
    /// By conversation and card id: where the person's answer goes.
    waiting: Mutex<HashMap<(String, String), oneshot::Sender<Given>>>,
    /// Calls, by key, whose app asked for a secret: their result says so.
    secrets: Mutex<HashSet<String>>,
}

/// A form shown on a card: its questions, and the person's answer once they give it.
pub(crate) struct Shown {
    pub(crate) questions: Vec<Question>,
    pub(crate) answer: oneshot::Receiver<Given>,
}

impl Engine {
    /// Shows the form `app` sent during the call with `key` as a card in that call's turn.
    /// `None` when it isn't shown, and the app reads `decline`: it asks for a secret (the call's
    /// result then says so, [`Engine::asked_for_secret`]), a card can't hold it, the call is a
    /// helper's (which can't ask), or its turn is gone.
    pub(crate) fn show_form(
        self: &Arc<Self>,
        key: &str,
        app: &str,
        message: &str,
        schema: &Value,
    ) -> Option<Shown> {
        let (id, call_id) = key.split_once('.')?;
        if self.helper_of(id).is_some() {
            return None;
        }
        let card = match elicit::card(app, message, schema) {
            Ok(card) => card,
            Err(elicit::Refused::Secret) => {
                lock(&self.app_forms.secrets).insert(key.to_owned());
                return None;
            }
            Err(elicit::Refused::Unreadable(why)) => {
                tracing::info!(%app, why, "an app's form wasn't shown");
                return None;
            }
        };
        let (tell, answer) = oneshot::channel();
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id).ok()?;
            let reply = running_in(&events, call_id)?;
            let shown_before = events
                .iter()
                .filter(|event| {
                    matches!(event, Event::Known(Known::QuestionAsked { call_id: c, .. })
                        if elicit::call_of(c) == Some(call_id))
                })
                .count();
            let card_id = elicit::card_id(call_id, shown_before + 1);
            let event = Event::Known(Known::QuestionAsked {
                reply,
                call_id: card_id.clone(),
                question: card.summary,
                questions: card.questions.clone(),
                later: false,
            });
            if let Err(error) = self.append(id, &event) {
                tracing::warn!(%error, "could not store an app's form");
                return None;
            }
            lock(&self.app_forms.waiting).insert((id.to_owned(), card_id), tell);
        }
        self.announce(id);
        Some(Shown {
            questions: card.questions,
            answer,
        })
    }

    /// Whether the app of the call with `key` asked for a secret, forgetting it.
    pub(crate) fn asked_for_secret(&self, key: &str) -> bool {
        lock(&self.app_forms.secrets).remove(key)
    }

    /// The person answers, defers or dismisses the form's card `card_id`: stored, then handed to
    /// the call waiting on it. Only an answer given here counts, and only once.
    pub(super) fn answer_form(
        self: &Arc<Self>,
        id: &str,
        card_id: &str,
        reply: QuestionReply,
    ) -> Result<(), QuestionError> {
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            let card = question::views(events.iter())
                .into_iter()
                .rev()
                .find(|c| c.call_id == card_id)
                .ok_or(QuestionError::NotOpen)?;
            if card.standing != Standing::Waiting {
                return Err(QuestionError::NotOpen);
            }
            let (event, given) = match reply {
                QuestionReply::Answers(given) => {
                    let answers = question::check_answers(&card.questions, &given)
                        .map_err(QuestionError::Invalid)?;
                    let event = Known::QuestionAnswered {
                        call_id: card_id.to_owned(),
                        answers: answers.clone(),
                        late: false,
                        typed: false,
                    };
                    (event, Given::Answers(answers))
                }
                QuestionReply::Defer => (dismissed(card_id), Given::Cancelled),
                QuestionReply::Dismiss => (dismissed(card_id), Given::Declined),
            };
            let place = (id.to_owned(), card_id.to_owned());
            let waiter = lock(&self.app_forms.waiting)
                .remove(&place)
                .filter(|waiter| !waiter.is_closed());
            match waiter {
                Some(waiter) => {
                    self.append(id, &Event::Known(event))?;
                    // Stored first: the app hears only an answer the conversation keeps.
                    let _ = waiter.send(given);
                    Ok(())
                }
                // No call waits on it any more: it closes, and the app never hears of it.
                None => {
                    self.append(id, &Event::Known(dismissed(card_id)))?;
                    Err(QuestionError::NotOpen)
                }
            }
        };
        self.announce(id);
        stored
    }
}

fn dismissed(card_id: &str) -> Known {
    Known::QuestionDismissed {
        call_id: card_id.to_owned(),
        late: false,
    }
}

/// The reply whose step made `call_id`, while that call has no result yet.
fn running_in(events: &[Event], call_id: &str) -> Option<String> {
    let finished = events.iter().any(|event| {
        matches!(event, Event::Known(Known::ToolFinished { call_id: c, .. }) if c == call_id)
    });
    if finished {
        return None;
    }
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::StepFinished { reply, calls, .. })
            if calls.iter().any(|call| call.id == call_id) =>
        {
            Some(reply.clone())
        }
        _ => None,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
