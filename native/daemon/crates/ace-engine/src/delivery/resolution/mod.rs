// SPDX-License-Identifier: Apache-2.0
//! `resolution.ts` (E5.5): validate an interaction's answer against the request it answers,
//! before claiming first-answer ownership. Pure over the two protocol objects.

use ace_json::Value;

/// `validResolution`: whether `resolution` answers `request` as it was offered.
pub fn valid_resolution(request: &Value, resolution: &Value) -> bool {
    fn kind(value: &Value) -> &str {
        value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
    if kind(request) != kind(resolution) {
        return false;
    }
    if kind(request) == "approval" {
        let option = resolution.get("optionId").and_then(Value::as_str);
        return request
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| {
                options
                    .iter()
                    .any(|offered| offered.get("id").and_then(Value::as_str) == option)
            });
    }
    if kind(request) != "question" {
        return true;
    }
    let answers = resolution
        .get("answers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let dismissed = resolution.get("dismissed") == Some(&Value::Bool(true));
    if dismissed {
        return answers.is_empty();
    }
    // `new Map(questions.map(q => [q.id, q]))`: a duplicate id keeps the last question, and the
    // answer count is compared with the map's size, not the array's length.
    let questions = request
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut by_id: Vec<(String, Value)> = Vec::new();
    for question in questions {
        let Some(id) = question
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        match by_id.iter_mut().find(|(known, _)| *known == id) {
            Some(slot) => slot.1 = question,
            None => by_id.push((id, question)),
        }
    }
    if answers.len() != by_id.len() {
        return false;
    }
    answers.iter().all(|(id, given)| {
        let Some((_, question)) = by_id.iter().find(|(known, _)| known == id) else {
            return false;
        };
        let Some(given) = given.as_array().filter(|given| !given.is_empty()) else {
            return false;
        };
        let multi = question.get("multiSelect") == Some(&Value::Bool(true));
        if !multi && given.len() != 1 {
            return false;
        }
        // Each answer once: `new Set(answers).size === answers.length`.
        for (index, answer) in given.iter().enumerate() {
            if given[..index].contains(answer) {
                return false;
            }
        }
        let allow_other = question.get("allowOther") == Some(&Value::Bool(true));
        given.iter().all(|answer| {
            let Some(answer) = answer.as_str() else {
                return false;
            };
            question
                .get("options")
                .and_then(Value::as_array)
                .is_some_and(|options| {
                    options
                        .iter()
                        .any(|option| option.get("id").and_then(Value::as_str) == Some(answer))
                })
                || (allow_other && !answer.trim().is_empty())
        })
    })
}

#[cfg(test)]
mod tests;
