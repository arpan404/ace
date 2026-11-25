// SPDX-License-Identifier: Apache-2.0
//! Pure rules E5.4a ports: `goal-change.ts`, `edited-context.ts` and `input-delivery.ts`'s
//! selection checks. `isDeepStrictEqual` is structural equality of the decoded JSON, and
//! `editedContext` compares `JSON.stringify` of both contexts, so key order counts.

use ace_json::Value;

/// `goal-change.ts:14`: the thread's goal after a provider report.
#[derive(Debug, Clone, PartialEq)]
pub enum GoalChange {
    Unchanged,
    Clear,
    Set(Value),
}

/// `goalChange(current, next)`: a null clears, an absent goal changes nothing, and the goal is
/// a `ProviderGoal` object compared structurally (`isDeepStrictEqual`).
pub fn goal_change(current: Option<&Value>, next: Option<&Value>) -> GoalChange {
    match next {
        None => GoalChange::Unchanged,
        Some(Value::Null) => {
            if current.is_some() {
                GoalChange::Clear
            } else {
                GoalChange::Unchanged
            }
        }
        Some(next) => match current {
            Some(current) if deep_strict_equal(current, next) => GoalChange::Unchanged,
            _ => GoalChange::Set(next.clone()),
        },
    }
}

/// `hasNextTurnSelection` (`input-delivery.ts:5`): an explicit model or options selection.
pub fn has_next_turn_selection(input: &Value) -> bool {
    input.get("model").is_some() || input.get("options").is_some()
}

/// `restatesSelection` (`input-delivery.ts:16`): a send that names only the selection the
/// thread already runs on changes nothing.
pub fn restates_selection(current: Option<&Value>, input: &Value) -> bool {
    let Some(current) = current else {
        return false;
    };
    if !has_next_turn_selection(input) {
        return false;
    }
    let model_restated = match input.get("model") {
        None => true,
        Some(model) => Some(model) == current.get("model"),
    };
    let options_restated = match input.get("options") {
        None => true,
        Some(options) => deep_strict_equal(options, &current["options"]),
    };
    model_restated && options_restated
}

/// `text(parts)` (`edited-context.ts:3`): the text parts joined, with no separator.
pub fn text(parts: &Value) -> String {
    let Value::Array(items) = parts else {
        return String::new();
    };
    items
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

/// `editedContext` (`edited-context.ts:14`): the context a queued message keeps through an edit.
pub fn edited_context(
    old_input: &Value,
    old_context: Option<&Value>,
    input: &Value,
    context: Option<&Value>,
) -> Option<Value> {
    let context = context?;
    if text(old_input) == text(input) {
        return Some(context.clone());
    }
    let unchanged = match old_context {
        Some(old) => ace_json::to_string(context) == ace_json::to_string(old),
        None => false,
    };
    if !unchanged {
        return Some(context.clone());
    }
    let attachments = context
        .get("attachments")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut attachment = ace_json::Map::new();
                    if let Some(hash) = item.get("sha256") {
                        attachment.insert("sha256", hash.clone());
                    }
                    Value::Object(attachment)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut edited = match context.as_object() {
        Some(map) => map.clone(),
        None => return Some(context.clone()),
    };
    edited.insert("attachments", Value::Array(attachments.into()));
    Some(Value::Object(edited))
}

/// `Object.is` for the two decoded values: structural, NaN equal, `-0` not `0`.
pub fn deep_strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => {
            let (left, right) = (left.value(), right.value());
            if left.is_nan() || right.is_nan() {
                return left.is_nan() && right.is_nan();
            }
            if left == 0.0 && right == 0.0 {
                return left.is_sign_negative() == right.is_sign_negative();
            }
            left == right
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right.iter())
                    .all(|(left, right)| deep_strict_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| deep_strict_equal(value, other))
                })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(value: &str) -> Value {
        let mut part = ace_json::Map::new();
        part.insert("type", Value::from("text"));
        part.insert("text", Value::from(value));
        Value::Array(vec![Value::Object(part)].into())
    }

    fn context(at: Option<i64>) -> Value {
        let mut shot = ace_json::Map::new();
        shot.insert("sha256", Value::from("a".repeat(64)));
        if let Some(at) = at {
            shot.insert("at", Value::from(at));
        }
        let mut notes = ace_json::Map::new();
        notes.insert("sha256", Value::from("b".repeat(64)));
        let mut map = ace_json::Map::new();
        map.insert("mentions", Value::Array(Vec::new().into()));
        map.insert(
            "attachments",
            Value::Array(vec![Value::Object(shot), Value::Object(notes)].into()),
        );
        Value::Object(map)
    }

    #[test]
    fn an_edit_with_new_text_drops_the_files_spots_it_carried() {
        let old = context(Some(5));
        let edited = edited_context(
            &parts("look here"),
            Some(&old),
            &parts("something else"),
            Some(&old),
        )
        .unwrap();
        let attachments = edited.get("attachments").and_then(Value::as_array).unwrap();
        assert_eq!(
            attachments
                .iter()
                .map(|item| item.get("at").is_none())
                .collect::<Vec<_>>(),
            vec![true, true]
        );
        assert_eq!(attachments.len(), 2);
    }

    #[test]
    fn unchanged_text_keeps_each_files_spot() {
        let old = context(Some(5));
        let edited = edited_context(
            &parts("look here"),
            Some(&old),
            &parts("look here"),
            Some(&old),
        )
        .unwrap();
        assert_eq!(edited, old);
    }

    #[test]
    fn a_new_context_keeps_the_spots_it_sets() {
        let old = context(Some(5));
        let mut moved = context(Some(2)).as_object().cloned().unwrap();
        moved.insert(
            "attachments",
            Value::Array(
                vec![Value::Object({
                    let mut shot = ace_json::Map::new();
                    shot.insert("sha256", Value::from("a".repeat(64)));
                    shot.insert("at", Value::from(2));
                    shot
                })]
                .into(),
            ),
        );
        let moved = Value::Object(moved);
        let edited = edited_context(
            &parts("look here"),
            Some(&old),
            &parts("something else"),
            Some(&moved),
        )
        .unwrap();
        assert_eq!(edited, moved);
    }

    #[test]
    fn an_edit_without_a_context_has_none() {
        let old = context(Some(5));
        assert_eq!(
            edited_context(&parts("look here"), Some(&old), &parts("else"), None),
            None
        );
    }

    fn goal(objective: &str) -> Value {
        let mut map = ace_json::Map::new();
        map.insert("objective", Value::from(objective));
        map.insert("status", Value::from("active"));
        Value::Object(map)
    }

    #[test]
    fn a_goal_clears_changes_or_stays_as_the_provider_reports_it() {
        // An object goal is kept whole; equality is structural; a null clears either shape.
        assert_eq!(
            goal_change(None, Some(&goal("Ship it"))),
            GoalChange::Set(goal("Ship it"))
        );
        assert_eq!(
            goal_change(Some(&goal("Ship it")), Some(&goal("Ship it"))),
            GoalChange::Unchanged
        );
        assert_eq!(
            goal_change(Some(&goal("Ship it")), Some(&goal("Test it"))),
            GoalChange::Set(goal("Test it"))
        );
        assert_eq!(
            goal_change(Some(&goal("Ship it")), Some(&Value::Null)),
            GoalChange::Clear
        );
        assert_eq!(goal_change(None, Some(&Value::Null)), GoalChange::Unchanged);
        assert_eq!(
            goal_change(Some(&goal("Ship it")), None),
            GoalChange::Unchanged
        );
    }

    #[test]
    fn a_selection_restated_exactly_changes_nothing() {
        let mut current = ace_json::Map::new();
        current.insert("model", Value::from("m"));
        let mut options = ace_json::Map::new();
        options.insert("effort", Value::from("high"));
        current.insert("options", Value::Object(options.clone()));
        let current = Value::Object(current);
        let mut input = ace_json::Map::new();
        input.insert("options", Value::Object(options));
        assert!(restates_selection(Some(&current), &Value::Object(input)));
        let mut other = ace_json::Map::new();
        other.insert("options", Value::from("different"));
        assert!(!restates_selection(Some(&current), &Value::Object(other)));
        // An explicit model that differs is a real change.
        let mut model = ace_json::Map::new();
        model.insert("model", Value::from("other"));
        assert!(!restates_selection(Some(&current), &Value::Object(model)));
    }
}
