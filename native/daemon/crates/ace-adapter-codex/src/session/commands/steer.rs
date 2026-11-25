// SPDX-License-Identifier: Apache-2.0
//! What a steer's reply means, and the notes a send that answered an
//! interaction owes (`session-commands.ts:117`-`:135` and `sendAnswer`).

use ace_json::{Map, Value};

use super::request::{expected_active_text, reply_message, steer_request, steer_target_lost_text};
use super::{Flight, settle};
use crate::session::frames::{Effect, Failure};
use crate::session::state::Session;

impl Session {
    /// A `turn/start`'s reply, and the notes a send that answered an
    /// interaction owes.
    pub(super) fn turn_settled(
        &mut self,
        thread: String,
        operation: u64,
        answering: Option<String>,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        let result = match reply {
            Ok(_) => Ok(Value::Null),
            Err(message) => Err(Failure::failed(message)),
        };
        self.follow(operation, &thread, answering, result)
    }

    /// `sendAnswer`'s notes, then the send's own settlement: `interaction-
    /// resolved` on success, `interaction-answer-failed` on failure.
    pub(super) fn follow(
        &mut self,
        operation: u64,
        thread: &str,
        answering: Option<String>,
        result: Result<Value, Failure>,
    ) -> Vec<Effect> {
        let Some(key) = answering else {
            return settle(operation, result);
        };
        let mut note = Map::new();
        let mut effects = Vec::new();
        if result.is_ok() {
            note.insert("event", Value::from("interaction-resolved"));
        } else {
            note.insert("event", Value::from("interaction-answer-failed"));
            note.insert("threadId", Value::from(thread.to_owned()));
        }
        note.insert("interaction", Value::from(key));
        effects.extend(self.emit_note(&Value::Object(note)));
        effects.extend(settle(operation, result));
        effects
    }
}

/// One steer's reply in flight.
pub(super) struct SteerSettled {
    pub(super) thread: String,
    pub(super) operation: u64,
    pub(super) turn: String,
    pub(super) input: Value,
    pub(super) client_user_message_id: Option<String>,
    pub(super) fenced: bool,
    pub(super) answering: Option<String>,
    pub(super) retried: bool,
}

impl Session {
    /// `session-commands.ts:117`-`:135`: what a refused steer means.
    pub(super) fn steer_settled(
        &mut self,
        steer: SteerSettled,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        let Err(message) = reply else {
            return self.follow(
                steer.operation,
                &steer.thread,
                steer.answering,
                Ok(Value::Null),
            );
        };
        let text = reply_message(message).unwrap_or_else(|| message.to_owned());
        // A replacement steer is the one retry TS allows (`:127`-`:130`), so
        // its own refusal is the answer: no third steer, no turn start, and no
        // mapping of the provider's words.
        if steer.retried {
            return self.follow(
                steer.operation,
                &steer.thread,
                steer.answering,
                Err(Failure::failed(message)),
            );
        }
        if steer.fenced {
            if steer_target_lost_text(&text) {
                return self.follow(
                    steer.operation,
                    &steer.thread,
                    steer.answering,
                    Err(Failure::steer_target_lost(text)),
                );
            }
            return self.follow(
                steer.operation,
                &steer.thread,
                steer.answering,
                Err(Failure::failed(message)),
            );
        }
        if !steer_target_lost_text(&text) {
            return self.follow(
                steer.operation,
                &steer.thread,
                steer.answering,
                Err(Failure::failed(message)),
            );
        }
        // A queued turn can start before the rejected steer's reply. It must
        // receive the input itself; turn/start would conflict with it.
        let replacement = self.active.get(&steer.thread).cloned();
        if let Some(next) = replacement
            .as_ref()
            .filter(|replacement| **replacement != steer.turn)
        {
            let call = self.calls.take();
            self.commands.insert(
                call,
                Flight::Steer {
                    thread: steer.thread.clone(),
                    operation: steer.operation,
                    turn: next.clone(),
                    input: steer.input.clone(),
                    client_user_message_id: steer.client_user_message_id.clone(),
                    fenced: steer.fenced,
                    answering: steer.answering,
                    retried: true,
                },
            );
            return vec![steer_request(
                call,
                &steer.thread,
                next,
                &steer.input,
                steer.client_user_message_id.as_deref(),
            )];
        }
        // The turn it named is gone and no other took its place: the steer was
        // refused unread, so the input starts a turn itself.
        if expected_active_text(&text) && replacement.as_deref() == Some(steer.turn.as_str()) {
            return self.follow(
                steer.operation,
                &steer.thread,
                steer.answering,
                Err(Failure::input_rejected(text)),
            );
        }
        let mut params = Map::new();
        params.insert("input", steer.input);
        if let Some(id) = steer.client_user_message_id {
            params.insert("clientUserMessageId", Value::from(id));
        }
        let thread = steer.thread;
        self.begin_start(steer.operation, &thread, params, steer.answering)
    }
}
