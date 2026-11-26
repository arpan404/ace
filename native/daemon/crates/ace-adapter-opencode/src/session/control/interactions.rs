// SPDX-License-Identifier: Apache-2.0
//! The answer to a native interaction (`interactions.ts` `nativeResolution`,
//! `commands.ts` `resolveNativeInteraction`): ace's resolution becomes the SDK
//! call that tells OpenCode, and nothing else.
//!
//! The call is built through the table (`session/api.rs`), so only the route's
//! fields reach the wire: the TypeScript's resolution object carries `kind`,
//! `sessionID`, `requestID`, `cancel` and `answer` beside the fields the route
//! sends, and none of them leaks into a body.
//!
//! Everything here is lenient reading of the protocol's JSON, as the rest of
//! the crate reads provider data. Every refusal keeps the one text the
//! TypeScript exposes (`request("interaction response", …)`), because SDK errors
//! may carry unsanitized bodies.

use ace_json::{Map, Value, json};

use crate::session::api::{self, ApiError, Call};
use crate::session::tenant::PendingInteraction;
use crate::translate::data::{arr_in, fields, s_in};

/// The one text a refused interaction response says: the TypeScript replaces
/// every failure (a bad choice, an unreadable answer, a refused request) with it.
pub const REFUSAL: &str = "OpenCode interaction response failed";

/// Why an interaction could not be answered.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ControlError {
    /// Not an approval, or an option OpenCode has no decision for.
    #[error("Unsupported OpenCode permission choice")]
    PermissionChoice,
    /// OpenCode's plan review is not one of its native interactions.
    #[error("OpenCode plan review is unsupported")]
    PlanReview,
    /// The answer is not what a form answer may be: a string, a number, a boolean
    /// or a list of strings, per field.
    #[error("OpenCode form answer failed its check")]
    Answer,
    /// The route needs a field the interaction does not hold.
    #[error("OpenCode interaction route: {0}")]
    Route(ApiError),
}

impl ControlError {
    /// What the caller says: always [`REFUSAL`].
    pub fn refusal(&self) -> &'static str {
        REFUSAL
    }
}

impl From<ApiError> for ControlError {
    fn from(error: ApiError) -> Self {
        Self::Route(error)
    }
}

/// The SDK call that answers `pending` with `choice`.
pub fn resolution(choice: &Value, pending: &PendingInteraction) -> Result<Call, ControlError> {
    let choice = fields(choice);
    let kind = s_in(choice, "kind");
    let data = fields(&pending.data);
    let id = s_in(data, "id");
    if pending.kind == "permission.asked" {
        // The permission route: an approval answer, and one of the three decisions.
        if kind != "approval" {
            return Err(ControlError::PermissionChoice);
        }
        let decision = match s_in(choice, "optionId") {
            "once" => "once",
            "always" => "always",
            "reject" => "reject",
            _ => return Err(ControlError::PermissionChoice),
        };
        let mut params = Map::new();
        params.insert("sessionID".to_owned(), json!(&pending.session));
        params.insert("requestID".to_owned(), json!(id));
        params.insert("decision".to_owned(), json!(decision));
        // `typeof p.message === "string"`: anything else is no message at all.
        if let Some(Value::String(message)) = choice.get("message") {
            params.insert("message".to_owned(), json!(message.as_str()));
        }
        return Ok(api::call("permission.reply", &Value::Object(params))?);
    }
    // The form routes: a question's answers, or an elicitation's content.
    let (cancel, message, answer) = if kind == "question" {
        let dismissed = matches!(choice.get("dismissed"), Some(Value::Bool(true)));
        let answers = choice.get("answers");
        let mut answer = Map::new();
        for field in arr_in(data, "fields") {
            let field = fields(field);
            let key = s_in(field, "key");
            let values = answer_values(answers.and_then(|answers| fields(answers).get(key)));
            let value = if s_in(field, "type") == "multiselect" {
                Value::Array(values.into_iter().cloned().collect())
            } else {
                values.first().map_or_else(
                    || Value::String(ace_json::JsString::from("")),
                    |v| (*v).clone(),
                )
            };
            answer.insert(key.to_owned(), value);
        }
        let message = choice
            .get("feedback")
            .filter(|value| value.as_str().is_some());
        (dismissed, message.cloned(), Value::Object(answer))
    } else if kind == "elicitation" {
        let content = choice.get("content").cloned().unwrap_or(Value::Null);
        let content = fields(&content);
        let message = content
            .get("feedback")
            .filter(|value| value.as_str().is_some())
            .cloned();
        (
            s_in(choice, "action") != "accept",
            message,
            Value::Object(content.clone()),
        )
    } else {
        return Err(ControlError::PlanReview);
    };
    if cancel {
        let mut params = Map::new();
        params.insert("sessionID".to_owned(), json!(&pending.session));
        params.insert("formID".to_owned(), json!(id));
        if let Some(message) = message {
            params.insert("message".to_owned(), message);
        }
        return Ok(api::call("session.form.cancel", &Value::Object(params))?);
    }
    form_answer(&answer)?;
    let params = json!({ "sessionID": &pending.session, "formID": id, "answer": answer });
    Ok(api::call("session.form.reply", &params)?)
}

/// The answer's values for one field: a list is its values, a bare string is one
/// value (the protocol writes one), and anything else is no answer.
fn answer_values(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(single) => vec![single],
        None => Vec::new(),
    }
}

/// `FormAnswer.parse`: a record whose values are strings, numbers, booleans or
/// lists of strings.
fn form_answer(answer: &Value) -> Result<(), ControlError> {
    let Value::Object(answer) = answer else {
        return Err(ControlError::Answer);
    };
    for (_, value) in answer.iter() {
        match value {
            Value::String(_) | Value::Bool(_) | Value::Number(_) => {}
            Value::Array(items) if items.iter().all(|item| item.as_str().is_some()) => {}
            _ => return Err(ControlError::Answer),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
