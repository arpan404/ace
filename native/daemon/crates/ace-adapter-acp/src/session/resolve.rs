// SPDX-License-Identifier: Apache-2.0
//! `resolve` and the resolution validation it shares with the engine
//! (`packages/adapter-acp/src/session.ts:820`-`:841`, `interactions.ts:273`).

use ace_json::{JsString, Value};

use super::core::{AcpCore, AcpEffect, AcpErrorWire};
use crate::translate::approval::interaction_key;
use crate::translate::data::{object, string};
use crate::translate::encode::encode_resolution;
use crate::translate::frame_redaction::redact_lease;
use crate::translate::interactions::interaction_request;
use crate::translate::settlement::{answer_is_neutral, answer_refuses_tool};

impl AcpCore {
    /// `resolve` (`session.ts:820`): the person's answer to an agent's request, published
    /// as the translator read it, validated, encoded back and answered in one step.
    pub fn resolve(
        &mut self,
        key: &str,
        resolution: &Value,
        effects: &mut Vec<AcpEffect>,
    ) -> Result<(), AcpErrorWire> {
        let key = JsString::from(key);
        let Some(pending) = self.pending.get(&key).cloned() else {
            return Err(AcpErrorWire::interaction(
                "ACP interaction is no longer pending",
            ));
        };
        // The request as published: lease secrets redacted, as the translator read it.
        let published = redact_lease(&pending.params, &self.secrets);
        let Some(request) = interaction_request(
            pending.method.as_str(),
            &published,
            self.quirks.translate_kind(),
        ) else {
            return Err(AcpErrorWire::interaction(
                "Interaction request is no longer valid",
            ));
        };
        let validated = validate_resolution(&request, resolution)?;
        let Some(answer) = encode_resolution(
            pending.method.as_str(),
            &published,
            &pending.params,
            &validated,
            &request,
        ) else {
            return Err(AcpErrorWire::interaction(
                "Interaction request is no longer valid",
            ));
        };
        let kind = string(object(&request).get("kind").unwrap_or(&Value::Null)).to_owned();
        let options = object(&request)
            .get("options")
            .and_then(Value::as_array)
            .map(|options| options.to_vec())
            .unwrap_or_default();
        self.pending.shift_remove(&key);
        if !answer_is_neutral(&kind, &options, Some(&validated)) {
            self.answered(
                &pending,
                answer_refuses_tool(&kind, &options, Some(&validated), false),
            );
        }
        let reply = self.peer.answer(&pending.id, &answer);
        self.apply_peer_effects(reply, effects);
        self.drain(effects);
        Ok(())
    }

    /// The interaction key of a published request id (`interactions.ts:271`).
    pub fn interaction_key_of(&self, id: &ace_supervisor::jsonrpc::RpcId) -> JsString {
        interaction_key(&to_translate_id(id))
    }
}

/// `validateResolution` (`interactions.ts:273`): the schema's own refusal, then the
/// request's kind, the approval's option and the questions' ids and answers.
pub fn validate_resolution(request: &Value, input: &Value) -> Result<Value, AcpErrorWire> {
    let resolution = object(input);
    let kind = match resolution.get("kind").and_then(Value::as_str) {
        Some(kind) => kind,
        // The schema refuses anything without a kind of its own.
        None => return Err(invalid("Invalid interaction resolution")),
    };
    // `ResolutionSchema.parse`: every kept field is typed, and what the schema does not
    // know is stripped (`z.object`, `protocol/src/interactions.ts:97`-`:125`).
    let mut kept = ace_json::Map::with_capacity(resolution.len());
    kept.insert("kind".to_owned(), Value::from(kind));
    match kind {
        "approval" => {
            kept.insert("optionId".to_owned(), string_field(resolution, "optionId")?);
            optional_string(resolution, &mut kept, "message")?;
        }
        "question" => {
            let answers = resolution
                .get("answers")
                .and_then(Value::as_object)
                .ok_or_else(invalid_resolution)?;
            let mut canonical = ace_json::Map::with_capacity(answers.len());
            for (id, selected) in answers.iter() {
                let selected = selected.as_array().ok_or_else(invalid_resolution)?;
                let mut values = Vec::with_capacity(selected.len());
                for answer in selected.iter() {
                    let Some(answer) = answer.as_str() else {
                        return Err(invalid_resolution());
                    };
                    values.push(Value::from(answer));
                }
                canonical.insert(id.clone(), Value::Array(values.into()));
            }
            kept.insert("answers".to_owned(), Value::Object(canonical));
            if let Some(dismissed) = resolution.get("dismissed") {
                let dismissed = dismissed.as_bool().ok_or_else(invalid_resolution)?;
                kept.insert("dismissed".to_owned(), Value::Bool(dismissed));
            }
            optional_string(resolution, &mut kept, "feedback")?;
            if let Some(Value::String(feedback)) = kept.get("feedback")
                && feedback.as_str().chars().count() > MAX_FEEDBACK_CODE_POINTS
            {
                return Err(invalid_resolution());
            }
        }
        "plan_review" => {
            let decision = string_field(resolution, "decision")?;
            if !matches!(decision.as_str(), Some("approve" | "reject" | "cancel")) {
                return Err(invalid_resolution());
            }
            kept.insert("decision".to_owned(), decision);
            optional_string(resolution, &mut kept, "feedback")?;
        }
        "elicitation" => {
            let action = string_field(resolution, "action")?;
            if !matches!(action.as_str(), Some("accept" | "decline" | "cancel")) {
                return Err(invalid_resolution());
            }
            kept.insert("action".to_owned(), action);
            if let Some(content) = resolution.get("content") {
                kept.insert("content".to_owned(), content.clone());
            }
        }
        "browser_help" => {
            let outcome = string_field(resolution, "outcome")?;
            if !matches!(outcome.as_str(), Some("done" | "skipped")) {
                return Err(invalid_resolution());
            }
            kept.insert("outcome".to_owned(), outcome);
        }
        _ => return Err(invalid_resolution()),
    }
    let validated = Value::Object(kept);
    let resolution = object(&validated);
    let request_map = object(request);
    if string(request_map.get("kind").unwrap_or(&Value::Null)) != kind {
        return Err(invalid("Interaction resolution kind does not match"));
    }
    if kind == "approval" {
        let option = resolution
            .get("optionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let known = request_map
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| {
                options
                    .iter()
                    .any(|entry| object(entry).get("id").and_then(Value::as_str) == Some(option))
            });
        if !known {
            return Err(invalid("Unknown approval option"));
        }
    }
    if kind == "question" {
        let answers = object(resolution.get("answers").unwrap_or(&Value::Null));
        let questions: Vec<Value> = request_map
            .get("questions")
            .and_then(Value::as_array)
            .map(|questions| questions.to_vec())
            .unwrap_or_default();
        if answers.keys().any(|id| {
            !questions
                .iter()
                .any(|q| question_id(q) == Some(id.as_str()))
        }) {
            return Err(invalid("Unknown question ID"));
        }
        let dismissed = resolution
            .get("dismissed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !dismissed {
            for question in &questions {
                let id = question_id(question).unwrap_or("");
                let selected = answers
                    .get(id)
                    .and_then(Value::as_array)
                    .map(|selected| selected.to_vec())
                    .unwrap_or_default();
                if !answer_valid(question, &selected) {
                    return Err(invalid("Invalid question answer"));
                }
            }
        }
    }
    Ok(validated)
}

/// The reply feedback's bound in code points: `feedback: z.string().max(8192)` is a zod
/// bound, and ace's patched zod counts code points, not UTF-16 units (rule 17).
const MAX_FEEDBACK_CODE_POINTS: usize = 8192;

/// A validation failure is a plain error, not an interaction that went away
/// (`interactions.ts:273`: `throw new Error(...)`).
fn invalid(message: &str) -> AcpErrorWire {
    AcpErrorWire::rpc_error(message.to_owned())
}

fn invalid_resolution() -> AcpErrorWire {
    invalid("Invalid interaction resolution")
}

fn string_field(resolution: &ace_json::Map, field: &str) -> Result<Value, AcpErrorWire> {
    match resolution.get(field).and_then(Value::as_str) {
        Some(value) => Ok(Value::from(value)),
        None => Err(invalid_resolution()),
    }
}

fn optional_string(
    resolution: &ace_json::Map,
    kept: &mut ace_json::Map,
    field: &str,
) -> Result<(), AcpErrorWire> {
    let Some(value) = resolution.get(field) else {
        return Ok(());
    };
    let text = value.as_str().ok_or_else(invalid_resolution)?;
    kept.insert(field.to_owned(), Value::from(text));
    Ok(())
}

fn question_id(question: &Value) -> Option<&str> {
    object(question).get("id").and_then(Value::as_str)
}

/// One question's answer (`interactions.ts:292`-`:300`): one selection, or several when
/// the question allows them, each a listed option unless the question allows other text.
fn answer_valid(question: &Value, selected: &[Value]) -> bool {
    let question = object(question);
    let multi = question
        .get("multiSelect")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow_other = question
        .get("allowOther")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if selected.is_empty() || (!multi && selected.len() > 1) {
        return false;
    }
    let options: Vec<Value> = question
        .get("options")
        .and_then(Value::as_array)
        .map(|options| options.to_vec())
        .unwrap_or_default();
    selected.iter().all(|answer| {
        allow_other
            || options
                .iter()
                .any(|option| object(option).get("id").and_then(Value::as_str) == answer.as_str())
    })
}

fn to_translate_id(id: &ace_supervisor::jsonrpc::RpcId) -> crate::translate::data::RpcId {
    match id {
        ace_supervisor::jsonrpc::RpcId::Text(text) => {
            crate::translate::data::RpcId::Str(text.clone())
        }
        ace_supervisor::jsonrpc::RpcId::Number(value) => {
            crate::translate::data::RpcId::FloatBits(value.to_bits())
        }
    }
}
