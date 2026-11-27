// SPDX-License-Identifier: Apache-2.0
//! A dialog's answer as Pi reads it, ported from `packages/adapter-pi/src/dialogs.ts`
//! (`dialogResponse`): the native `extension_ui_response` a resolution becomes.

use ace_json::{JsString, Map, Value};
use ace_protocol::generated::InteractionResolution;

/// Why a resolution cannot answer the dialog. Every message is the TypeScript's own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiDialogError {
    #[error("Expected Pi confirmation answer")]
    ExpectedConfirmation,
    #[error("Invalid Pi confirmation")]
    InvalidConfirmation,
    #[error("Expected Pi question resolution")]
    ExpectedQuestion,
    #[error("Pi dialogs require one answer")]
    OneAnswer,
    #[error("Missing answer")]
    MissingAnswer,
    #[error("Unknown Pi selection")]
    UnknownSelection,
    #[error("Pi dialog is no longer pending")]
    NotPending,
}

/// `dialogResponse`: `{type: "extension_ui_response", id, ...}` for one resolution.
pub fn dialog_response(
    dialog: &Value,
    resolution: &InteractionResolution,
) -> Result<Map, PiDialogError> {
    let map = dialog.as_object().ok_or(PiDialogError::ExpectedQuestion)?;
    let id = map
        .get("id")
        .and_then(Value::as_str)
        .ok_or(PiDialogError::NotPending)?;
    let method = map
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut base = Map::with_capacity(4);
    base.insert("type", Value::from("extension_ui_response"));
    base.insert("id", Value::String(JsString::from(id)));

    let (answers, dismissed) = match resolution {
        InteractionResolution::Question {
            answers, dismissed, ..
        } => (answers, dismissed.unwrap_or(false)),
        _ => {
            return Err(if method == "confirm" {
                PiDialogError::ExpectedConfirmation
            } else {
                PiDialogError::ExpectedQuestion
            });
        }
    };
    if dismissed {
        base.insert("cancelled", Value::Bool(true));
        return Ok(base);
    }
    if method == "confirm" {
        let answer = one_answer(answers, id);
        if !matches!(answer, Some("yes") | Some("no")) {
            return Err(PiDialogError::InvalidConfirmation);
        }
        base.insert("confirmed", Value::Bool(answer == Some("yes")));
        return Ok(base);
    }
    let answer = one_answer(answers, id).ok_or(PiDialogError::OneAnswer)?;
    if method == "select" {
        let options = map.get("options").and_then(Value::as_array);
        let index = js_integer(answer).ok_or(PiDialogError::UnknownSelection)?;
        let canonical = index.to_string();
        if canonical != answer {
            return Err(PiDialogError::UnknownSelection);
        }
        let value = usize::try_from(index)
            .ok()
            .and_then(|index| options.and_then(|options| options.get(index)))
            .and_then(Value::as_str)
            .ok_or(PiDialogError::UnknownSelection)?;
        base.insert("value", Value::String(JsString::from(value)));
        return Ok(base);
    }
    base.insert("value", Value::String(JsString::from(answer)));
    Ok(base)
}

/// `answers[id]` as the single string the TypeScript requires.
fn one_answer<'a>(
    answers: &'a serde_json::Map<String, serde_json::Value>,
    id: &str,
) -> Option<&'a str> {
    let answers = answers.get(id)?.as_array()?;
    if answers.len() != 1 {
        return None;
    }
    answers.first()?.as_str()
}

/// `Number.isInteger(Number(answer))`, where the answer's canonical decimal form must equal
/// the answer itself (`String(index) === answer`). Only plain integers survive that check.
fn js_integer(answer: &str) -> Option<i64> {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        // `Number("")` is 0, but `String(0)` is "0", never "".
        return None;
    }
    trimmed.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    // Ported from the session process cases of `session.process.test.ts`: "selection answers
    // use native offered labels and cannot be sent twice" and "generic confirmation is a
    // yes/no question and replies with native confirmed".
    use super::*;

    fn dialog(value: Value) -> Value {
        value
    }

    fn select() -> Value {
        dialog(Value::Object({
            let mut map = Map::with_capacity(4);
            map.insert("type", Value::from("extension_ui_request"));
            map.insert("id", Value::from("select"));
            map.insert("method", Value::from("select"));
            map.insert(
                "options",
                Value::Array(vec![Value::from("Tabs"), Value::from("Spaces")].into()),
            );
            map
        }))
    }

    fn confirm() -> Value {
        dialog(Value::Object({
            let mut map = Map::with_capacity(3);
            map.insert("type", Value::from("extension_ui_request"));
            map.insert("id", Value::from("confirm"));
            map.insert("method", Value::from("confirm"));
            map
        }))
    }

    fn question(id: &str, answers: &[&str], dismissed: bool) -> InteractionResolution {
        let mut map = serde_json::Map::new();
        map.insert(
            id.to_owned(),
            serde_json::Value::Array(
                answers
                    .iter()
                    .map(|answer| serde_json::Value::String((*answer).to_owned()))
                    .collect(),
            ),
        );
        InteractionResolution::Question {
            answers: map,
            dismissed: dismissed.then_some(true),
            feedback: None,
        }
    }

    #[test]
    fn a_selection_answers_with_the_offered_label_and_an_unknown_index_is_refused() {
        let response = dialog_response(&select(), &question("select", &["1"], false)).expect("ok");
        assert_eq!(
            response.get("value").and_then(Value::as_str),
            Some("Spaces")
        );
        assert_eq!(
            dialog_response(&select(), &question("select", &["9"], false)).unwrap_err(),
            PiDialogError::UnknownSelection
        );
    }

    #[test]
    fn a_confirmation_answers_native_confirmed_and_a_wrong_answer_is_refused() {
        let response =
            dialog_response(&confirm(), &question("confirm", &["no"], false)).expect("ok");
        assert_eq!(response.get("confirmed"), Some(&Value::Bool(false)));
        assert_eq!(
            dialog_response(&confirm(), &question("confirm", &["maybe"], false)).unwrap_err(),
            PiDialogError::InvalidConfirmation
        );
    }

    #[test]
    fn a_dismissed_dialog_answers_cancelled_and_two_answers_are_refused() {
        let response = dialog_response(&select(), &question("select", &[], true)).expect("ok");
        assert_eq!(response.get("cancelled"), Some(&Value::Bool(true)));
        assert_eq!(
            dialog_response(&select(), &question("select", &["0", "1"], false)).unwrap_err(),
            PiDialogError::OneAnswer
        );
    }
}
