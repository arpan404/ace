use std::sync::Arc;

use serde_json::Value;
use spade_core::Transcript;
use spade_core::event::{Event, Known};
use spade_core::question::{self, Standing};
use spade_models::{Message, Prompt};
use spade_store::StoreError;

use super::Engine;
use crate::tools::ToolOutput;

impl Engine {
    fn child_parent(&self, id: &str) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .store
            .helper(id)?
            .filter(|row| row.profile != spade_core::lane::PROFILE)
            .map(|row| (row.parent, format!("helper: {}", row.profile))))
    }

    pub(super) fn ask_question(
        self: &Arc<Self>,
        id: &str,
        reply: &str,
        asked: &[Event],
    ) -> Result<bool, StoreError> {
        if self.is_lane(id) {
            return self.ask_lane_question(id, reply, asked);
        }
        let (parent, start) = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if spade_core::turn::stop_requested(&self.load(id)?, reply) {
                return Ok(false);
            }
            let (
                Some((parent, from)),
                Some(Event::Known(Known::QuestionAsked {
                    call_id,
                    question,
                    questions,
                    ..
                })),
            ) = (self.child_parent(id)?, asked.first())
            else {
                self.append_events(id, asked)?;
                return Ok(true);
            };
            let parent_events = self.load(&parent)?;
            let start = self.admission.load(std::sync::atomic::Ordering::SeqCst)
                && !self.closed(&parent)
                && !self.deleting(&parent)
                && Transcript::fold(parent_events.iter())
                    .open_reply()
                    .is_none();
            let mut batch = vec![Event::Known(Known::ChildAsked {
                ask: self.ids.next("ask"),
                child: id.to_owned(),
                reply: reply.to_owned(),
                call_id: call_id.clone(),
                from,
                question: question.clone(),
                questions: questions.clone(),
            })];
            if start {
                batch.push(Event::reply_started(
                    self.ids.next("r"),
                    self.reply_model(&parent),
                ));
            }
            self.append_across(&[(id, asked), (&parent, &batch)], &[])?;
            (parent, start)
        };
        if start {
            self.spawn_turn(&parent);
        } else {
            self.live(&parent).wake.notify_one();
        }
        self.announce(&parent);
        Ok(true)
    }

    pub(super) fn has_waiting_child_question(&self, events: &[Event]) -> bool {
        question::pending_children(events).any(|event| match event {
            Known::ChildAsked {
                child,
                reply,
                call_id,
                ..
            } => self.waits_on_child_question(child, reply, call_id),
            _ => false,
        })
    }

    pub(super) fn with_child_asks(&self, events: &[Event], mut prompt: Prompt) -> Prompt {
        let mut notes = Vec::new();
        for request in question::pending_children(events) {
            let Known::ChildAsked {
                ask,
                child,
                reply,
                call_id,
                from,
                question,
                questions,
            } = request
            else {
                continue;
            };
            if !self.waits_on_child_question(child, reply, call_id) {
                continue;
            }
            let data =
                serde_json::json!({"from": from, "question": question, "questions": questions});
            let data = data.to_string().replace('<', "\\u003c");
            notes.push(format!(
                "<child_ask id=\"{ask}\" kind=\"question\">\n{data}\n</child_ask>"
            ));
        }
        if !notes.is_empty() {
            notes.reverse();
            prompt.messages.push(Message::Person {
                text: notes.join("\n"),
                images: Vec::new(),
            });
        }
        prompt
    }

    fn waits_on_child_question(&self, child: &str, reply: &str, call_id: &str) -> bool {
        self.load(child).is_ok_and(|events| {
            !spade_core::turn::stop_requested(&events, reply)
                && Transcript::fold(events.iter())
                    .open_reply()
                    .is_some_and(|open| open.reply.as_deref() == Some(reply))
                && question::standing(events.iter(), call_id) == Some(Standing::Waiting)
        })
    }

    pub(crate) fn child_answer(&self, parent: &str, ask_id: &str, answer: &[Value]) -> ToolOutput {
        let result = (|| -> Result<String, String> {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(parent).map_err(|e| e.to_string())?;
            let request = question::pending_children(&events).find(|event| {
                matches!(
                    event, Known::ChildAsked { ask, .. } if ask == ask_id
                )
            });
            let Some(Known::ChildAsked {
                child,
                reply,
                call_id,
                questions,
                ..
            }) = request
            else {
                return Err("That child question is no longer open.".to_owned());
            };
            if self
                .child_parent(child)
                .map_err(|e| e.to_string())?
                .is_none_or(|(owner, _)| owner != parent)
                || !self.waits_on_child_question(child, reply, call_id)
            {
                return Err("That child question is no longer open.".to_owned());
            }
            let answers = question::check_answers(questions, answer)?;
            self.append_across(
                &[
                    (
                        child,
                        &[
                            Event::Known(Known::QuestionAnswered {
                                call_id: call_id.clone(),
                                answers,
                                late: false,
                                typed: false,
                            }),
                            Event::Known(Known::ChildAnswerDelivered {}),
                        ],
                    ),
                    (
                        parent,
                        &[Event::Known(Known::ChildAnswered {
                            ask: ask_id.to_owned(),
                        })],
                    ),
                ],
                &[],
            )
            .map_err(|e| e.to_string())?;
            Ok(child.clone())
        })();
        match result {
            Ok(child) => {
                self.live(&child).wake.notify_one();
                self.announce(&child);
                ToolOutput::ok("Answer delivered.")
            }
            Err(error) => ToolOutput::error(error),
        }
    }
}
