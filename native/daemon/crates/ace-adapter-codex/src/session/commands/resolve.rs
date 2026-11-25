// SPDX-License-Identifier: Apache-2.0
//! Answering what Codex asks (`resolution.ts`, `session-commands.ts:251`-`:356`):
//! a permission approval, an MCP tool approval, a question, or a plan review.
//! The answer to a server request goes back as an `Answer` effect; a question or
//! a plan is delivered as input, which is why its notes follow that send's reply.

use ace_json::{Map, Value};

use super::approval::approval_result;
use super::{Send, settle};
use crate::session::frames::Effect;
use crate::session::input::native_input;
use crate::session::state::{AsyncQuestion, Session};

/// `CodexInteractionUnavailable`'s message.
pub(crate) const UNAVAILABLE: &str = "This question or approval is no longer active";
/// One `resolve`, as the facade hands it over.
pub struct Answer<'a> {
    /// The facade promise this answer settles.
    pub operation: u64,
    /// The interaction's key.
    pub key: String,
    /// The engine's `InteractionResolution`.
    pub resolution: &'a Value,
    /// `io.userMessageId`, for the input a question or plan delivers.
    pub user_message_id: &'a dyn Fn() -> String,
    /// `ctx.interactionId?.(key)`, for the answer's note.
    pub interaction_id: Option<&'a str>,
    /// `getModel()`: the model a plan's settings carry.
    pub model: &'a str,
}

impl Session {
    /// `resolve(key, resolution)`: the pending approval, the question, or the
    /// plan review this key names.
    pub fn resolve(&mut self, answer: Answer<'_>) -> Vec<Effect> {
        if self.is_closed() {
            return settle(answer.operation, Err(unavailable()));
        }
        if let Some(pending) = self.pending.get(&answer.key) {
            let result = match approval_result(pending, answer.resolution) {
                Ok(result) => result,
                Err(message) => return settle(answer.operation, Err(failure(message))),
            };
            let id = pending.id.clone();
            self.pending.shift_remove(&answer.key);
            let mut effects = settle(answer.operation, Ok(Value::Null));
            effects.insert(0, Effect::Answer { id, result });
            return effects;
        }
        let Some(question) = self.async_questions.get(&answer.key).cloned() else {
            let Some(plan) = self.plans.get(&answer.key).cloned() else {
                return settle(answer.operation, Err(unavailable()));
            };
            return self.resolve_plan(plan, answer);
        };
        if answer.resolution.get("kind").and_then(Value::as_str) != Some("question") {
            return settle(answer.operation, Err(unavailable()));
        }
        self.async_questions.shift_remove(&answer.key);
        let text = question_text(&question, answer.resolution);
        self.answer_with_input(
            question.thread,
            &answer.key,
            &text,
            answer.interaction_id,
            answer.user_message_id,
            answer.operation,
        )
    }

    /// A plan review's decision: proceed, or only say it was resolved.
    fn resolve_plan(
        &mut self,
        plan: crate::session::state::Plan,
        answer: Answer<'_>,
    ) -> Vec<Effect> {
        if answer.resolution.get("kind").and_then(Value::as_str) != Some("plan_review") {
            return settle(answer.operation, Err(unavailable()));
        }
        self.plans.shift_remove(&answer.key);
        let decision = answer
            .resolution
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let feedback = answer
            .resolution
            .get("feedback")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if decision == "cancel" || (decision != "approve" && feedback.is_empty()) {
            let mut effects =
                self.emit_note(&interaction_note("interaction-resolved", &answer.key));
            effects.extend(settle(answer.operation, Ok(Value::Null)));
            return effects;
        }
        let text = match decision == "approve" {
            true => "Implement the plan.".to_owned(),
            false => feedback.to_owned(),
        };
        let mut effects =
            self.interaction_answer(&plan.thread, &answer.key, &text, answer.interaction_id);
        // `collaborationMode` is the plan's own: approve runs it, anything else
        // keeps planning with the feedback.
        let parts = match native_input(&[text_part(&text)]) {
            Ok(input) => input,
            Err(message) => {
                effects.extend(settle(answer.operation, Err(failure(message))));
                return effects;
            }
        };
        let mut settings = Map::new();
        settings.insert("model", Value::from(answer.model.to_owned()));
        settings.insert("reasoning_effort", Value::Null);
        settings.insert("developer_instructions", Value::Null);
        let mut collaboration = Map::new();
        collaboration.insert(
            "mode",
            Value::from(match decision == "approve" {
                true => "default",
                false => "plan",
            }),
        );
        collaboration.insert("settings", Value::Object(settings));
        let mut params = Map::new();
        params.insert("input", parts);
        params.insert("collaborationMode", Value::Object(collaboration));
        effects.extend(self.begin_start(answer.operation, &plan.thread, params, Some(answer.key)));
        effects
    }

    /// `sendAnswer(thread, key, text, () => sendTo(thread, [text], "steer"))`:
    /// the answer's note first, then the steer, whose reply settles the resolve.
    fn answer_with_input(
        &mut self,
        thread: String,
        key: &str,
        text: &str,
        interaction_id: Option<&str>,
        user_message_id: &dyn Fn() -> String,
        operation: u64,
    ) -> Vec<Effect> {
        let mut effects = self.interaction_answer(&thread, key, text, interaction_id);
        let parts = [text_part(text)];
        effects.extend(self.send_to(
            &thread,
            Send {
                operation,
                parts: &parts,
                delivery: ace_adapter_api::session::Delivery::Steer,
                command_id: None,
                origin: None,
                fence: None,
                user_message_id,
                answering: Some(key),
            },
        ));
        effects
    }

    /// `interaction-answer`: the answer's text before it is sent.
    fn interaction_answer(
        &mut self,
        thread: &str,
        key: &str,
        text: &str,
        interaction_id: Option<&str>,
    ) -> Vec<Effect> {
        let mut note = Map::new();
        note.insert("event", Value::from("interaction-answer"));
        note.insert("threadId", Value::from(thread.to_owned()));
        note.insert("interaction", Value::from(key.to_owned()));
        note.insert("text", Value::from(text.to_owned()));
        if let Some(interaction_id) = interaction_id {
            note.insert("interactionId", Value::from(interaction_id.to_owned()));
        }
        self.emit_note(&Value::Object(note))
    }
}

fn interaction_note(event: &str, key: &str) -> Value {
    let mut note = Map::new();
    note.insert("event", Value::from(event.to_owned()));
    note.insert("interaction", Value::from(key.to_owned()));
    Value::Object(note)
}

fn text_part(text: &str) -> Value {
    let mut part = Map::new();
    part.insert("type", Value::from("text"));
    part.insert("text", Value::from(text.to_owned()));
    Value::Object(part)
}

fn unavailable() -> crate::session::frames::Failure {
    failure(UNAVAILABLE.to_owned())
}

fn failure(message: String) -> crate::session::frames::Failure {
    crate::session::frames::Failure::failed(message)
}

/// The question's answer as the text Codex receives: the chosen options' labels,
/// one question per `;`, or a dismissal that says so.
fn question_text(question: &AsyncQuestion, resolution: &Value) -> String {
    let dismissed = resolution
        .get("dismissed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let note = resolution
        .get("feedback")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if dismissed {
        return match note.is_empty() {
            true => "Continue without answers.".to_owned(),
            false => format!("Continue without answers. {note}"),
        };
    }
    let answers = resolution
        .get("answers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    answers
        .iter()
        .map(|(id, chosen)| {
            chosen
                .as_array()
                .map(|chosen| {
                    chosen
                        .iter()
                        .map(|answer| option_label(&question.questions, id.as_str(), answer))
                        .collect::<Vec<String>>()
                        .join(", ")
                })
                .unwrap_or_default()
        })
        .collect::<Vec<String>>()
        .join("; ")
}

/// One answer's label: the option's, else the answer's own id.
fn option_label(questions: &Value, id: &str, answer: &Value) -> String {
    let answer_id = answer.as_str().unwrap_or_default();
    for question in questions
        .as_array()
        .map(|questions| questions.to_vec())
        .unwrap_or_default()
    {
        if question.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        for option in question
            .get("options")
            .and_then(Value::as_array)
            .map(|options| options.to_vec())
            .unwrap_or_default()
        {
            if option.get("id").and_then(Value::as_str) == Some(answer_id)
                && let Some(label) = option.get("label").and_then(Value::as_str)
            {
                return label.to_owned();
            }
        }
    }
    answer_id.to_owned()
}
