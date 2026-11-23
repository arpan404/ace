// SPDX-License-Identifier: Apache-2.0
//! Native answers (`interactions.ts`: resolution). The session answers a
//! pending interaction; unsupported answers are refused, never retried.

use crate::translate::data::{arr_in, fields, get, s_in};
use crate::translate::state::{Pending, StateError};
use ace_json::Value;
use std::collections::BTreeMap;

pub(crate) fn validate_resolution(value: &Value) -> Result<(), StateError> {
    let resolution = fields(value);
    match resolution.get("kind") {
        Some(Value::String(kind)) => match kind.as_str() {
            "approval" => {
                if !matches!(resolution.get("optionId"), Some(Value::String(_))) {
                    return Err(StateError::Limit("resolution"));
                }
                if let Some(message) = resolution.get("message")
                    && !matches!(message, Value::String(_))
                {
                    return Err(StateError::Limit("resolution"));
                }
            }
            "question" => {
                let answers = match resolution.get("answers") {
                    Some(Value::Object(answers)) => answers,
                    _ => return Err(StateError::Limit("resolution")),
                };
                for (_, value) in answers {
                    match value {
                        Value::Array(values)
                            if values.iter().all(|entry| matches!(entry, Value::String(_))) => {}
                        _ => return Err(StateError::Limit("resolution")),
                    }
                }
                if let Some(dismissed) = resolution.get("dismissed")
                    && !matches!(dismissed, Value::Bool(_))
                {
                    return Err(StateError::Limit("resolution"));
                }
                if let Some(Value::String(feedback)) = resolution.get("feedback") {
                    if feedback.encode_utf16().count() > 8192 {
                        return Err(StateError::Limit("resolution"));
                    }
                } else if resolution.get("feedback").is_some() {
                    return Err(StateError::Limit("resolution"));
                }
            }
            "elicitation" => {
                if !matches!(
                    resolution.get("action"),
                    Some(Value::String(action))
                        if action == "accept" || action == "decline" || action == "cancel"
                ) {
                    return Err(StateError::Limit("resolution"));
                }
            }
            "plan_review" => {
                if !matches!(
                    resolution.get("decision"),
                    Some(Value::String(decision))
                        if decision == "approve" || decision == "reject" || decision == "cancel"
                ) {
                    return Err(StateError::Limit("resolution"));
                }
                if let Some(feedback) = resolution.get("feedback")
                    && !matches!(feedback, Value::String(_))
                {
                    return Err(StateError::Limit("resolution"));
                }
            }
            "browser_help" => {
                if !matches!(
                    resolution.get("outcome"),
                    Some(Value::String(outcome)) if outcome == "done" || outcome == "skipped"
                ) {
                    return Err(StateError::Limit("resolution"));
                }
            }
            _ => return Err(StateError::Limit("resolution")),
        },
        _ => return Err(StateError::Limit("resolution")),
    }
    Ok(())
}

/// The session's answer to a pending interaction, for `ProviderSession.resolve`.
pub enum NativeResolve {
    Permission {
        session_id: String,
        request_id: String,
        decision: PermissionDecision,
        message: Option<String>,
    },
    Form {
        session_id: String,
        form_id: String,
        cancel: bool,
        message: Option<String>,
        answer: Value,
    },
}

/// A permission answer: allow once, for the project, or deny.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Once,
    Always,
    Reject,
}

/// Answer a pending interaction the way `nativeResolution` does.
pub fn native_resolution(choice: &Value, pending: &Pending) -> Result<NativeResolve, StateError> {
    let pending_data: Value = ace_json::parse(pending.data.get())?;
    let data = fields(&pending_data);
    let id = s_in(data, "id").to_owned();
    let session_id = pending.session.clone();
    let decision = fields(choice);
    if pending.typ == "permission.asked" {
        if s_in(decision, "kind") != "approval" {
            return Err(StateError::Limit("resolution"));
        }
        let option = s_in(decision, "optionId");
        let choice = if option == "once" {
            PermissionDecision::Once
        } else if option == "always" {
            PermissionDecision::Always
        } else if option == "reject" {
            PermissionDecision::Reject
        } else {
            return Err(StateError::Limit("resolution"));
        };
        return Ok(NativeResolve::Permission {
            session_id,
            request_id: id,
            decision: choice,
            message: match decision.get("message") {
                Some(Value::String(message)) => Some(String::from(message.clone())),
                _ => None,
            },
        });
    }
    if s_in(decision, "kind") == "question" {
        let given = fields(get(decision, "answers"));
        let mut answer: BTreeMap<String, Value> = BTreeMap::new();
        for field in arr_in(data, "fields") {
            let f = fields(field);
            let key = s_in(f, "key").to_owned();
            let raw: Vec<Value> = match given.get(&key) {
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|entry| match entry {
                        Value::String(entry) => Value::String(entry.clone()),
                        _ => Value::from(String::new()),
                    })
                    .collect(),
                _ => vec![],
            };
            answer.insert(
                key.clone(),
                if s_in(f, "type") == "multiselect" {
                    Value::from(raw)
                } else {
                    raw.into_iter()
                        .next()
                        .unwrap_or(Value::from(String::new()))
                },
            );
        }
        let dismissed = matches!(decision.get("dismissed"), Some(Value::Bool(true)));
        return Ok(NativeResolve::Form {
            session_id,
            form_id: id,
            cancel: dismissed,
            message: match decision.get("feedback") {
                Some(Value::String(feedback)) => Some(String::from(feedback.clone())),
                _ => None,
            },
            answer: Value::Object(answer.into_iter().collect()),
        });
    }
    if s_in(decision, "kind") == "elicitation" {
        let content = fields(get(decision, "content"));
        return Ok(NativeResolve::Form {
            session_id,
            form_id: id,
            cancel: s_in(decision, "action") != "accept",
            message: match content.get("feedback") {
                Some(Value::String(feedback)) => Some(String::from(feedback.clone())),
                _ => None,
            },
            answer: Value::Object(content.clone()),
        });
    }
    Err(StateError::Limit("resolution"))
}
