// SPDX-License-Identifier: Apache-2.0
//! Interaction resolutions (split from `interactions.rs`).

use ace_json::{Map, Value};

use super::json::{object, str_of};

pub fn resolution_for(request: &Value, value: &Value, canonical: &Value) -> Value {
    if let Some(parsed) = parse_resolution(canonical) {
        let want = str_of(object(request).get("kind").unwrap_or(&Value::Null));
        let got = str_of(object(&parsed).get("kind").unwrap_or(&Value::Null));
        if !want.is_empty() && want == got {
            return parsed;
        }
    }
    let result = object(value);
    let allowed = result.get("behavior").and_then(|v| v.as_str()) == Some("allow");
    let message = str_of(result.get("message").unwrap_or(&Value::Null));
    let kind = str_of(object(request).get("kind").unwrap_or(&Value::Null));
    match kind.as_str() {
        "question" => {
            let updated = object(result.get("updatedInput").unwrap_or(&Value::Null));
            let answers = object(updated.get("answers").unwrap_or(&Value::Null));
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("question".to_owned()));
            let mut out = Map::with_capacity(answers.len());
            for (k, v) in answers {
                match v {
                    Value::String(s) => {
                        out.insert(k.clone(), Value::from(vec![Value::String(s.clone())]));
                    }
                    Value::Array(items) => {
                        let kept: Vec<Value> = items
                            .iter()
                            .filter_map(|item| match item {
                                Value::String(s) => Some(Value::String(s.clone())),
                                _ => None,
                            })
                            .collect();
                        out.insert(k.clone(), Value::from(kept));
                    }
                    _ => {
                        out.insert(k.clone(), Value::from(Vec::new()));
                    }
                }
            }
            map.insert("answers".to_owned(), Value::Object(out));
            if !allowed {
                map.insert("dismissed".to_owned(), Value::Bool(true));
            }
            Value::Object(map)
        }
        "plan_review" => {
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("plan_review".to_owned()));
            let decision = if allowed {
                "approve"
            } else if result.get("interrupt") == Some(&Value::Bool(true)) {
                "cancel"
            } else {
                "reject"
            };
            map.insert("decision".to_owned(), Value::from(decision.to_owned()));
            map.insert("feedback".to_owned(), Value::from(message));
            Value::Object(map)
        }
        "elicitation" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("elicitation".to_owned()));
            map.insert("action".to_owned(), Value::from("cancel".to_owned()));
            Value::Object(map)
        }
        _ => {
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("approval".to_owned()));
            map.insert(
                "optionId".to_owned(),
                Value::from(if allowed { "allow_once" } else { "deny" }.to_owned()),
            );
            map.insert("message".to_owned(), Value::from(message));
            Value::Object(map)
        }
    }
}

/// Parse a stored resolution, stripped to the schema's known fields.
pub fn parse_resolution(value: &Value) -> Option<Value> {
    let obj = object(value);
    let kind = obj.get("kind").and_then(|v| v.as_str())?;
    match kind {
        "approval" => {
            let option = obj.get("optionId").and_then(|v| v.as_str())?;
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("approval".to_owned()));
            map.insert("optionId".to_owned(), Value::from(option.to_owned()));
            if let Some(Value::String(m)) = obj.get("message") {
                map.insert("message".to_owned(), Value::String(m.clone()));
            } else if obj.get("message").is_some() {
                return None;
            }
            Some(Value::Object(map))
        }
        "question" => {
            let answers = match obj.get("answers") {
                Some(Value::Object(m)) => m,
                _ => return None,
            };
            let mut out = Map::with_capacity(answers.len());
            for (k, v) in answers {
                match v {
                    Value::Array(items) => {
                        let mut kept = Vec::with_capacity(items.len());
                        for item in items {
                            match item {
                                Value::String(s) => kept.push(Value::String(s.clone())),
                                _ => return None,
                            }
                        }
                        out.insert(k.clone(), Value::from(kept));
                    }
                    _ => return None,
                }
            }
            let mut map = Map::with_capacity(4);
            map.insert("kind".to_owned(), Value::from("question".to_owned()));
            map.insert("answers".to_owned(), Value::Object(out));
            if let Some(Value::Bool(d)) = obj.get("dismissed") {
                map.insert("dismissed".to_owned(), Value::Bool(*d));
            } else if obj.get("dismissed").is_some() {
                return None;
            }
            if let Some(Value::String(f)) = obj.get("feedback") {
                if f.chars().count() > 8192 {
                    return None;
                }
                map.insert("feedback".to_owned(), Value::String(f.clone()));
            } else if obj.get("feedback").is_some() {
                return None;
            }
            Some(Value::Object(map))
        }
        "plan_review" => {
            let decision = obj.get("decision").and_then(|v| v.as_str())?;
            if !["approve", "reject", "cancel"].contains(&decision) {
                return None;
            }
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("plan_review".to_owned()));
            map.insert("decision".to_owned(), Value::from(decision.to_owned()));
            if let Some(Value::String(f)) = obj.get("feedback") {
                map.insert("feedback".to_owned(), Value::String(f.clone()));
            } else if obj.get("feedback").is_some() {
                return None;
            }
            Some(Value::Object(map))
        }
        "elicitation" => {
            let action = obj.get("action").and_then(|v| v.as_str())?;
            if !["accept", "decline", "cancel"].contains(&action) {
                return None;
            }
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("elicitation".to_owned()));
            map.insert("action".to_owned(), Value::from(action.to_owned()));
            if let Some(content) = obj.get("content") {
                map.insert("content".to_owned(), content.clone());
            }
            Some(Value::Object(map))
        }
        "browser_help" => {
            let outcome = obj.get("outcome").and_then(|v| v.as_str())?;
            if !["done", "skipped"].contains(&outcome) {
                return None;
            }
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("browser_help".to_owned()));
            map.insert("outcome".to_owned(), Value::from(outcome.to_owned()));
            Some(Value::Object(map))
        }
        _ => None,
    }
}

/// Parse a stored elicitation request, stripped to known fields.
pub fn parse_elicitation_request(value: &Value) -> Option<Value> {
    let obj = object(value);
    if obj.get("kind").and_then(|v| v.as_str()) != Some("elicitation") {
        return None;
    }
    let server = obj.get("server").and_then(|v| v.as_str())?;
    let message = obj.get("message").and_then(|v| v.as_str())?;
    if let Some(v) = obj.get("mode")
        && v.as_str() != Some("form")
        && v.as_str() != Some("url")
    {
        return None;
    }
    let mut map = Map::with_capacity(8);
    map.insert("kind".to_owned(), Value::from("elicitation".to_owned()));
    map.insert("server".to_owned(), Value::from(server.to_owned()));
    map.insert("message".to_owned(), Value::from(message.to_owned()));
    for key in ["url", "schema", "mode", "nativeId", "title", "description"] {
        if let Some(v) = obj.get(key) {
            if (key == "url" || key == "nativeId" || key == "title" || key == "description")
                && !matches!(v, Value::String(_))
            {
                return None;
            }
            map.insert(key.to_owned(), v.clone());
        }
    }
    Some(Value::Object(map))
}
