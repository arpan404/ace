// SPDX-License-Identifier: Apache-2.0
//! Permission requests and resolutions (`interactions.ts`).

use crate::translate::approval::{approval_request, local_option_id, published_option_id};
use crate::translate::data::{list, object, string};
use crate::translate::frame_redaction::LEASE_REDACTION;
use crate::translate::mcp::mcp_arguments;
use crate::translate::quirks::QuirksKind;
use crate::translate::tools::tool_detail;
use serde_json::{Map, Value};

/// A validated interaction request, or None.
pub fn interaction_request(method: &str, params: &Value, quirks: QuirksKind) -> Option<Value> {
    let params_map = object(params);
    let call = object(params_map.get("toolCall").unwrap_or(&Value::Null)).clone();
    let call_value = Value::Object(call.clone());
    let mut request: Option<Value> = None;
    if method == "cursor/create_plan" {
        let mut map = Map::with_capacity(5);
        map.insert("kind".to_owned(), Value::String("plan_review".to_owned()));
        map.insert(
            "title".to_owned(),
            Value::String(string(params_map.get("name").unwrap_or(&Value::Null)).to_owned()),
        );
        map.insert(
            "summary".to_owned(),
            Value::String(string(params_map.get("overview").unwrap_or(&Value::Null)).to_owned()),
        );
        map.insert(
            "markdown".to_owned(),
            Value::String(string(params_map.get("plan").unwrap_or(&Value::Null)).to_owned()),
        );
        if let Some(todos) = params_map.get("todos") {
            map.insert("todos".to_owned(), todos.clone());
        }
        request = Some(Value::Object(map));
    } else if method == "cursor/ask_question" {
        let questions: Vec<Value> = list(params_map.get("questions").unwrap_or(&Value::Null))
            .iter()
            .map(object)
            .map(|question| {
                let mut map = Map::with_capacity(6);
                map.insert(
                    "id".to_owned(),
                    Value::String(string(question.get("id").unwrap_or(&Value::Null)).to_owned()),
                );
                map.insert(
                    "text".to_owned(),
                    Value::String(
                        string(question.get("prompt").unwrap_or(&Value::Null)).to_owned(),
                    ),
                );
                map.insert(
                    "options".to_owned(),
                    question.get("options").cloned().unwrap_or(Value::Null),
                );
                map.insert(
                    "multiSelect".to_owned(),
                    Value::Bool(
                        question
                            .get("allowMultiple")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    ),
                );
                map.insert("allowOther".to_owned(), Value::Bool(false));
                Value::Object(map)
            })
            .collect();
        let mut map = Map::with_capacity(2);
        map.insert("kind".to_owned(), Value::String("question".to_owned()));
        map.insert("questions".to_owned(), Value::Array(questions));
        request = Some(Value::Object(map));
    } else if method == "session/request_permission" {
        let options: Vec<Map<String, Value>> =
            list(params_map.get("options").unwrap_or(&Value::Null))
                .iter()
                .map(object)
                .cloned()
                .collect();
        let antigravity = quirks == QuirksKind::Antigravity;
        if antigravity
            && string(call.get("toolCallId").unwrap_or(&Value::Null)).starts_with("interaction_")
        {
            let option_values: Vec<Value> = options
                .iter()
                .enumerate()
                .map(|(index, option)| {
                    let mut map = Map::with_capacity(2);
                    map.insert(
                        "id".to_owned(),
                        Value::String(local_option_id(option, index)),
                    );
                    map.insert(
                        "label".to_owned(),
                        Value::String(
                            string(option.get("name").unwrap_or(&Value::Null)).to_owned(),
                        ),
                    );
                    Value::Object(map)
                })
                .collect();
            let mut question = Map::with_capacity(4);
            question.insert(
                "id".to_owned(),
                Value::String(string(call.get("toolCallId").unwrap_or(&Value::Null)).to_owned()),
            );
            question.insert(
                "text".to_owned(),
                Value::String(string(call.get("title").unwrap_or(&Value::Null)).to_owned()),
            );
            question.insert("options".to_owned(), Value::Array(option_values));
            question.insert("multiSelect".to_owned(), Value::Bool(false));
            question.insert("allowOther".to_owned(), Value::Bool(false));
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("question".to_owned()));
            map.insert(
                "questions".to_owned(),
                Value::Array(vec![Value::Object(question)]),
            );
            request = Some(Value::Object(map));
        } else {
            request = Some(approval_request(&call_value, &options, quirks));
        }
    }
    let request = request?;
    // Validate like InteractionRequest.safeParse: kind must match and required fields present.
    if validate_request(&request) {
        Some(request)
    } else {
        None
    }
}

fn validate_request(request: &Value) -> bool {
    let map = object(request);
    match map.get("kind").and_then(Value::as_str) {
        Some("approval") => {
            map.get("title").and_then(Value::as_str).is_some()
                && map.get("options").and_then(Value::as_array).is_some()
        }
        Some("question") => map.get("questions").and_then(Value::as_array).is_some(),
        Some("plan_review") => map.get("markdown").and_then(Value::as_str).is_some(),
        _ => false,
    }
}

/// Decode a native answer into a validated resolution.
pub fn decode_resolution(
    method: &str,
    params: &Value,
    response: &Value,
    request: &Value,
) -> Option<Value> {
    let outcome = object(object(response).get("outcome").unwrap_or(&Value::Null)).clone();
    let params_map = object(params);
    let options: Vec<Map<String, Value>> = list(params_map.get("options").unwrap_or(&Value::Null))
        .iter()
        .map(object)
        .cloned()
        .collect();
    let selected = published_option_id(
        &options,
        string(outcome.get("optionId").unwrap_or(&Value::Null)),
    );
    let request_kind = object(request)
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if request_kind == "approval"
        && string(outcome.get("outcome").unwrap_or(&Value::Null)) == "selected"
    {
        let mut map = Map::with_capacity(2);
        map.insert("kind".to_owned(), Value::String("approval".to_owned()));
        map.insert("optionId".to_owned(), Value::String(selected));
        return Some(Value::Object(map));
    }
    if request_kind == "question" {
        if method == "session/request_permission"
            && string(outcome.get("outcome").unwrap_or(&Value::Null)) == "selected"
        {
            let tool_call_id = string(
                object(params_map.get("toolCall").unwrap_or(&Value::Null))
                    .get("toolCallId")
                    .unwrap_or(&Value::Null),
            )
            .to_owned();
            let mut answers = Map::with_capacity(1);
            answers.insert(tool_call_id, Value::Array(vec![Value::String(selected)]));
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("question".to_owned()));
            map.insert("answers".to_owned(), Value::Object(answers));
            return Some(Value::Object(map));
        }
        if string(outcome.get("outcome").unwrap_or(&Value::Null)) == "skipped" {
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::String("question".to_owned()));
            map.insert("answers".to_owned(), Value::Object(Map::new()));
            map.insert("dismissed".to_owned(), Value::Bool(true));
            return Some(Value::Object(map));
        }
        if string(outcome.get("outcome").unwrap_or(&Value::Null)) == "answered" {
            let mut answers = Map::with_capacity(4);
            for entry in list(outcome.get("answers").unwrap_or(&Value::Null)) {
                let entry_map = object(entry);
                let question_id =
                    string(entry_map.get("questionId").unwrap_or(&Value::Null)).to_owned();
                let selected: Vec<Value> =
                    list(entry_map.get("selectedOptionIds").unwrap_or(&Value::Null))
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|text| Value::String(text.to_owned()))
                        .collect();
                answers.insert(question_id, Value::Array(selected));
            }
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("question".to_owned()));
            map.insert("answers".to_owned(), Value::Object(answers));
            return Some(Value::Object(map));
        }
    }
    if request_kind == "plan_review"
        && ["accepted", "rejected"]
            .contains(&string(outcome.get("outcome").unwrap_or(&Value::Null)))
    {
        let mut map = Map::with_capacity(3);
        map.insert("kind".to_owned(), Value::String("plan_review".to_owned()));
        let decision = if string(outcome.get("outcome").unwrap_or(&Value::Null)) == "accepted" {
            "approve"
        } else {
            "reject"
        };
        map.insert("decision".to_owned(), Value::String(decision.to_owned()));
        if let Some(Value::String(reason)) = outcome.get("reason") {
            map.insert("feedback".to_owned(), Value::String(reason.clone()));
        }
        return Some(Value::Object(map));
    }
    None
}
