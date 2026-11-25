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
    if !schema_valid(kind, resolution) {
        return Err(invalid("Invalid interaction resolution"));
    }
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
    Ok(input.clone())
}

fn invalid(message: &str) -> AcpErrorWire {
    AcpErrorWire::interaction(message.to_owned())
}

/// The shapes `ResolutionSchema` admits (`protocol/src/interactions.ts:97`-`:125`).
fn schema_valid(kind: &str, resolution: &ace_json::Map) -> bool {
    match kind {
        "approval" => resolution.get("optionId").is_some_and(Value::is_string),
        "question" => {
            resolution
                .get("answers")
                .is_some_and(|answers| answers.as_object().is_some())
                && resolution
                    .get("dismissed")
                    .is_none_or(|dismissed| dismissed.as_bool().is_some())
        }
        "plan_review" => matches!(
            resolution.get("decision").and_then(Value::as_str),
            Some("approve" | "reject" | "cancel")
        ),
        "elicitation" => matches!(
            resolution.get("action").and_then(Value::as_str),
            Some("accept" | "decline" | "cancel")
        ),
        "browser_help" => matches!(
            resolution.get("outcome").and_then(Value::as_str),
            Some("done" | "skipped")
        ),
        _ => false,
    }
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
