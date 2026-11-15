//! The person answering a bot's question card (ADR 0154, docs/questions.md): answers, Answer
//! later and Never mind. The rules are `spade_core::question`; this stores what the person did
//! and wakes the turn, or delivers a late answer like a job's result.

use std::sync::Arc;

use serde_json::Value;
use spade_core::event::{Event, Known};
use spade_core::question::{self, Standing, View};
use spade_store::StoreError;

use super::Engine;

/// What the person did with a card.
#[derive(Debug, Clone, PartialEq)]
pub enum QuestionReply {
    /// One answer per question, in order.
    Answers(Vec<Value>),
    /// Answer later.
    Defer,
    /// Never mind.
    Dismiss,
}

#[derive(Debug, thiserror::Error)]
pub enum QuestionError {
    #[error("no such conversation")]
    NotFound,
    #[error("that question is not open")]
    NotOpen,
    /// The answers break the question's rules; the words say which.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// Answers, defers or dismisses the question card `call_id` asked. A waiting card's answer
    /// lands in the waiting turn; a deferred card's is delivered like a job's result: it steers
    /// the open reply or starts one, once.
    pub fn answer_question(
        self: &Arc<Self>,
        id: &str,
        call_id: &str,
        reply: QuestionReply,
    ) -> Result<(), QuestionError> {
        if self.store.conversation(id)?.is_none() {
            return Err(QuestionError::NotFound);
        }
        let waiting = {
            // Checked and stored under one lock, so two answers to one card cannot both land.
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            let card = question::views(&events)
                .into_iter()
                .rev()
                .find(|c| c.call_id == call_id)
                .ok_or(QuestionError::NotOpen)?;
            let event = match (card.standing, reply) {
                (Standing::Waiting, QuestionReply::Answers(given)) => {
                    let answers = question::check_answers(&card.questions, &given)
                        .map_err(QuestionError::Invalid)?;
                    Known::QuestionAnswered {
                        call_id: call_id.to_owned(),
                        answers,
                        late: false,
                        typed: false,
                    }
                }
                (Standing::Waiting, QuestionReply::Defer) => Known::QuestionDeferred {
                    call_id: call_id.to_owned(),
                    by_bot: false,
                },
                (Standing::Waiting, QuestionReply::Dismiss) => Known::QuestionDismissed {
                    call_id: call_id.to_owned(),
                    late: false,
                },
                (Standing::Deferred, QuestionReply::Answers(given)) => {
                    let answers = question::check_answers(&card.questions, &given)
                        .map_err(QuestionError::Invalid)?;
                    Known::QuestionAnswered {
                        call_id: call_id.to_owned(),
                        answers,
                        late: true,
                        typed: false,
                    }
                }
                (Standing::Deferred, QuestionReply::Dismiss) => Known::QuestionDismissed {
                    call_id: call_id.to_owned(),
                    late: true,
                },
                _ => return Err(QuestionError::NotOpen),
            };
            let event = Event::Known(event);
            if card.standing == Standing::Waiting {
                self.append(id, &event)?;
                None
            } else {
                Some(event)
            }
        };
        match waiting {
            // The waiting turn reads it now.
            None => {
                self.live(id).wake.notify_one();
                self.announce(id);
                Ok(())
            }
            // Delivered under its own lock, which finds a card answered meanwhile.
            Some(late) => match self.deliver_as(id, &late, None)? {
                spade_store::Delivered::Stored(_) => {
                    self.announce(id);
                    Ok(())
                }
                _ => Err(QuestionError::NotOpen),
            },
        }
    }

    /// Every question card in the conversation, oldest first; `None` for an unknown one.
    pub fn questions_view(&self, id: &str) -> Result<Option<Vec<View>>, StoreError> {
        if self.store.conversation(id)?.is_none() {
            return Ok(None);
        }
        Ok(Some(question::views(&self.load(id)?)))
    }
}
