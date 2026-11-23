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
        // A lane's card asked in main goes to the lane, then main's copy closes (ADR 0217 §4).
        // Main's copy closes in the same write as a waiting card; a late answer, delivered to
        // the lane on its own, closes it after.
        let (target, inner) = self
            .lane_question(id, call_id)
            .unwrap_or_else(|| (id.to_owned(), call_id.to_owned()));
        let answered = self.answer_card(&target, &inner, reply)?;
        if let Some((answered, false)) = answered
            && self.is_lane(&target)
        {
            self.close_in_main(&target, &inner, &answered);
        }
        Ok(())
    }

    /// Answers the card `call_id` of `id` and says what was stored and whether main's copy of a
    /// lane's card closed with it (nothing for an app's form, which is never asked in main).
    fn answer_card(
        self: &Arc<Self>,
        id: &str,
        call_id: &str,
        reply: QuestionReply,
    ) -> Result<Option<(Event, bool)>, QuestionError> {
        if !self.reachable(id)? {
            return Err(QuestionError::NotFound);
        }
        // An app's form goes back to the call waiting on it (ADR 0202 §2).
        if question::elicit::call_of(call_id).is_some() {
            return self.answer_form(id, call_id, reply).map(|()| None);
        }
        let waiting = {
            // Checked and stored under one lock, so two answers to one card cannot both land.
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            let card = question::views(events.iter())
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
                // A lane's card closes main's copy in the same write (ADR 0217 §4).
                match self.closed_copy(id, call_id, &event) {
                    Some((main, closed)) => {
                        let lane = std::slice::from_ref(&event);
                        self.append_across(&[(id, lane), (main.as_str(), &[closed])], &[])?;
                        Ok((event, true))
                    }
                    None => {
                        self.append(id, &event)?;
                        Ok((event, false))
                    }
                }
            } else {
                Err(event)
            }
        };
        match waiting {
            // The waiting turn reads it now.
            Ok((event, closed)) => {
                self.live(id).wake.notify_one();
                self.announce(id);
                if let Some(row) = self.lane_row(id).filter(|_| closed) {
                    self.announce(&row.parent);
                }
                Ok(Some((event, closed)))
            }
            // Delivered under its own lock, which finds a card answered meanwhile.
            Err(late) => match self.deliver_as(id, &late, None)? {
                spade_store::Delivered::Stored(_) => {
                    self.announce(id);
                    Ok(Some((late, false)))
                }
                _ => Err(QuestionError::NotOpen),
            },
        }
    }

    /// Every question card in the conversation, oldest first; `None` for an unknown one.
    pub fn questions_view(&self, id: &str) -> Result<Option<Vec<View>>, StoreError> {
        if !self.reachable(id)? {
            return Ok(None);
        }
        Ok(Some(question::views(self.load(id)?.iter())))
    }
}
