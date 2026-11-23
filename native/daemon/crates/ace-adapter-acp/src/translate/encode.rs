// SPDX-License-Identifier: Apache-2.0
//! Native answers to validated resolutions (`interactions.ts` encode half).

use crate::translate::approval::native_option_id;
use crate::translate::data::{list, object};
use ace_json::{Map, Value};

pub fn encode_resolution(
    method: &str,
    published_params: &Value,
    native_params: &Value,
    resolution: &Value,
    request: &Value,
) -> Option<Value> {
    let published: Vec<Map> = list(
        object(published_params)
            .get("options")
            .unwrap_or(&Value::Null),
    )
    .iter()
    .map(object)
    .cloned()
    .collect();
    let native: Vec<Map> = list(object(native_params).get("options").unwrap_or(&Value::Null))
        .iter()
        .map(object)
        .cloned()
        .collect();
    let native_for = |local: &str| {
        native_option_id(&published, &native, local).unwrap_or_else(|| local.to_owned())
    };
    let resolution_map = object(resolution);
    let kind = resolution_map
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("");
    if kind == "approval" {
        let option_id = resolution_map
            .get("optionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut outcome = Map::with_capacity(2);
        outcome.insert("outcome".to_owned(), Value::from("selected".to_owned()));
        outcome.insert("optionId".to_owned(), Value::from(native_for(option_id)));
        let mut out = Map::with_capacity(1);
        out.insert("outcome".to_owned(), Value::Object(outcome));
        return Some(Value::Object(out));
    }
    if kind == "question" {
        let dismissed = resolution_map
            .get("dismissed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if dismissed {
            let mut outcome = Map::with_capacity(1);
            outcome.insert(
                "outcome".to_owned(),
                Value::from(if method == "session/request_permission" {
                    "cancelled".to_owned()
                } else {
                    "skipped".to_owned()
                }),
            );
            let mut out = Map::with_capacity(1);
            out.insert("outcome".to_owned(), Value::Object(outcome));
            return Some(Value::Object(out));
        }
        if method == "session/request_permission" {
            let request_map = object(request);
            let first_id = request_map
                .get("questions")
                .and_then(Value::as_array)
                .and_then(|questions| questions.first())
                .and_then(|question| question.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let answers = object(resolution_map.get("answers").unwrap_or(&Value::Null));
            let selected = answers
                .get(first_id)
                .and_then(Value::as_array)
                .and_then(|list| list.first())
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut outcome = Map::with_capacity(2);
            outcome.insert("outcome".to_owned(), Value::from("selected".to_owned()));
            outcome.insert("optionId".to_owned(), Value::from(native_for(selected)));
            let mut out = Map::with_capacity(1);
            out.insert("outcome".to_owned(), Value::Object(outcome));
            return Some(Value::Object(out));
        }
        let mut answers_out: Vec<Value> = Vec::new();
        if let Some(Value::Object(answers)) = resolution_map.get("answers") {
            for (question_id, selected) in answers.iter() {
                let selected_ids: Vec<Value> = selected
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|value| value.is_string())
                    .collect();
                let mut entry = Map::with_capacity(2);
                entry.insert("questionId".to_owned(), Value::String(question_id.clone()));
                entry.insert("selectedOptionIds".to_owned(), Value::from(selected_ids));
                answers_out.push(Value::Object(entry));
            }
        }
        let mut outcome = Map::with_capacity(2);
        outcome.insert("outcome".to_owned(), Value::from("answered".to_owned()));
        outcome.insert("answers".to_owned(), Value::from(answers_out));
        let mut out = Map::with_capacity(1);
        out.insert("outcome".to_owned(), Value::Object(outcome));
        return Some(Value::Object(out));
    }
    if kind == "plan_review" {
        let decision = resolution_map
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("");
        let outcome_text = match decision {
            "approve" => "accepted",
            "reject" => "rejected",
            _ => "cancelled",
        };
        let mut outcome = Map::with_capacity(2);
        outcome.insert("outcome".to_owned(), Value::from(outcome_text.to_owned()));
        if let Some(Value::String(feedback)) = resolution_map.get("feedback") {
            outcome.insert("reason".to_owned(), Value::String(feedback.clone()));
        }
        let mut out = Map::with_capacity(1);
        out.insert("outcome".to_owned(), Value::Object(outcome));
        return Some(Value::Object(out));
    }
    None
}
