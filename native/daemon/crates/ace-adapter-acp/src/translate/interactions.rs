// SPDX-License-Identifier: Apache-2.0
//! Permission requests and resolutions (`interactions.ts`).

use crate::translate::data::{list, object, string};
use crate::translate::frame_redaction::LEASE_REDACTION;
use crate::translate::quirks::QuirksKind;
use crate::translate::tools::{mcp_arguments, tool_detail};
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

fn approval_request(call: &Value, options: &[Map<String, Value>], quirks: QuirksKind) -> Value {
    let detail = tool_detail(call, quirks);
    let input = object(object(call).get("rawInput").unwrap_or(&Value::Null)).clone();
    let paths: Vec<Value> = list(object(call).get("locations").unwrap_or(&Value::Null))
        .iter()
        .map(object)
        .map(|location| string(location.get("path").unwrap_or(&Value::Null)).to_owned())
        .filter(|path| !path.is_empty() && path.len() <= 4096)
        .take(128)
        .map(Value::String)
        .collect();
    let detail_map = object(&detail);
    let mcp = if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "mcp")
        && detail_map
            .get("server")
            .and_then(Value::as_str)
            .is_some_and(|server| !server.is_empty())
        && detail_map
            .get("tool")
            .and_then(Value::as_str)
            .is_some_and(|tool| !tool.is_empty())
    {
        Some((
            detail_map
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            detail_map
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ))
    } else {
        None
    };
    let tool_name = if let Some((server, tool)) = mcp.clone() {
        format!("mcp__{server}__{tool}")
    } else if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "shell")
    {
        "shell".to_owned()
    } else {
        let kind = string(object(call).get("kind").unwrap_or(&Value::Null));
        format!("acp/{}", if kind.is_empty() { "other" } else { kind })
    };
    let mut target = Map::with_capacity(6);
    target.insert(
        "tool".to_owned(),
        Value::String(tool_name.chars().take(256).collect()),
    );
    let access = if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "shell")
    {
        "execute"
    } else {
        match string(object(call).get("kind").unwrap_or(&Value::Null)) {
            "read" => "read",
            "edit" | "delete" | "move" => "write",
            "execute" => "execute",
            _ => "unknown",
        }
    };
    target.insert("access".to_owned(), Value::String(access.to_owned()));
    target.insert(
        "input".to_owned(),
        if mcp.is_some() {
            mcp_arguments(&input)
        } else {
            object(call).get("rawInput").cloned().unwrap_or(Value::Null)
        },
    );
    if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "shell")
    {
        if let Some(command) = detail_map.get("command").and_then(Value::as_str)
            && !command.is_empty()
        {
            target.insert(
                "command".to_owned(),
                Value::String(bounded_command(command)),
            );
        }
        if let Some(cwd) = detail_map.get("cwd").and_then(Value::as_str)
            && !cwd.is_empty()
        {
            target.insert(
                "cwd".to_owned(),
                Value::String(cwd.chars().take(4096).collect()),
            );
        }
    }
    target.insert("paths".to_owned(), Value::Array(paths));
    let mut map = Map::with_capacity(6);
    map.insert("kind".to_owned(), Value::String("approval".to_owned()));
    map.insert(
        "title".to_owned(),
        Value::String({
            let title = string(object(call).get("title").unwrap_or(&Value::Null));
            if title.is_empty() {
                tool_name.clone()
            } else {
                title.to_owned()
            }
        }),
    );
    map.insert("target".to_owned(), Value::Object(target));
    if let Some((server, _)) = mcp {
        let mut mcp_server = Map::with_capacity(2);
        mcp_server.insert(
            "name".to_owned(),
            Value::String(server.chars().take(256).collect::<String>()),
        );
        mcp_server.insert("source".to_owned(), Value::String("acp".to_owned()));
        map.insert("mcpServer".to_owned(), Value::Object(mcp_server));
    }
    let option_values: Vec<Value> = options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            let mut entry = Map::with_capacity(3);
            entry.insert(
                "id".to_owned(),
                Value::String(local_option_id(option, index)),
            );
            entry.insert(
                "label".to_owned(),
                Value::String(string(option.get("name").unwrap_or(&Value::Null)).to_owned()),
            );
            entry.insert(
                "kind".to_owned(),
                Value::String(option_kind(string(
                    option.get("kind").unwrap_or(&Value::Null),
                ))),
            );
            Value::Object(entry)
        })
        .collect();
    map.insert("options".to_owned(), Value::Array(option_values));
    Value::Object(map)
}

fn bounded_command(command: &str) -> String {
    const LIMIT: usize = 32768;
    if command.len() <= LIMIT {
        return command.to_owned();
    }
    let truncation_note =
        |hidden: usize| format!("\n[command truncated: {hidden} more characters not shown]");
    let mut kept = LIMIT.saturating_sub(truncation_note(command.len()).len());
    kept = LIMIT.saturating_sub(truncation_note(command.len().saturating_sub(kept)).len());
    let kept_text: String = command.chars().take(kept).collect();
    format!("{kept_text}{}", truncation_note(command.len() - kept))
}

fn local_option_id(option: &Map<String, Value>, index: usize) -> String {
    let id = string(option.get("optionId").unwrap_or(&Value::Null));
    if id.contains(LEASE_REDACTION) {
        format!("ace-option:{index}")
    } else {
        id.to_owned()
    }
}

fn native_option_id(
    published: &[Map<String, Value>],
    native: &[Map<String, Value>],
    local: &str,
) -> Option<String> {
    let index = published
        .iter()
        .enumerate()
        .find(|(position, option)| local_option_id(option, *position) == *local)
        .map(|(position, _)| position)?;
    native
        .get(index)
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn published_option_id(options: &[Map<String, Value>], native_id: &str) -> String {
    let index = options
        .iter()
        .position(|option| {
            option
                .get("optionId")
                .and_then(Value::as_str)
                .is_some_and(|id| id == native_id)
        })
        .unwrap_or(usize::MAX);
    if index == usize::MAX {
        return native_id.to_owned();
    }
    local_option_id(&options[index], index)
}

fn option_kind(kind: &str) -> String {
    match kind {
        "allow_once" => "allow_once",
        "allow_session" => "allow_session",
        "allow_always" => "allow_always",
        "reject_once" | "deny" => "deny",
        "reject_always" | "deny_always" => "deny_always",
        "cancel" => "cancel",
        _ => "other",
    }
    .to_owned()
}

/// Stable process-local request key.
pub fn interaction_key(id: &crate::translate::data::RpcId) -> String {
    format!("request:{}:{}", id.typeof_name(), id.display())
}

/// The native answer to a validated resolution.
pub fn encode_resolution(
    method: &str,
    published_params: &Value,
    native_params: &Value,
    resolution: &Value,
    request: &Value,
) -> Option<Value> {
    let published: Vec<Map<String, Value>> = list(
        object(published_params)
            .get("options")
            .unwrap_or(&Value::Null),
    )
    .iter()
    .map(object)
    .cloned()
    .collect();
    let native: Vec<Map<String, Value>> =
        list(object(native_params).get("options").unwrap_or(&Value::Null))
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
        outcome.insert("outcome".to_owned(), Value::String("selected".to_owned()));
        outcome.insert("optionId".to_owned(), Value::String(native_for(option_id)));
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
                Value::String(if method == "session/request_permission" {
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
            outcome.insert("outcome".to_owned(), Value::String("selected".to_owned()));
            outcome.insert("optionId".to_owned(), Value::String(native_for(selected)));
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
                entry.insert("selectedOptionIds".to_owned(), Value::Array(selected_ids));
                answers_out.push(Value::Object(entry));
            }
        }
        let mut outcome = Map::with_capacity(2);
        outcome.insert("outcome".to_owned(), Value::String("answered".to_owned()));
        outcome.insert("answers".to_owned(), Value::Array(answers_out));
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
        outcome.insert("outcome".to_owned(), Value::String(outcome_text.to_owned()));
        if let Some(Value::String(feedback)) = resolution_map.get("feedback") {
            outcome.insert("reason".to_owned(), Value::String(feedback.clone()));
        }
        let mut out = Map::with_capacity(1);
        out.insert("outcome".to_owned(), Value::Object(outcome));
        return Some(Value::Object(out));
    }
    None
}
