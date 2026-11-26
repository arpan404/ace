// SPDX-License-Identifier: Apache-2.0
//! Fact constructors for message content (split from `content.rs` to keep
//! modules small; same shapes the TypeScript emits).

use ace_json::{Map, Value};

use super::json::raw;

pub(crate) fn text_block(s: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("text".to_owned()));
    map.insert("text".to_owned(), Value::from(s.to_owned()));
    Value::Object(map)
}

pub(crate) fn part_text(text: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("text".to_owned()));
    map.insert("text".to_owned(), Value::from(text.to_owned()));
    Value::Object(map)
}

pub(crate) fn upsert(agent: &str, item: &str, draft: Value) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("item".to_owned(), Value::from(item.to_owned()));
    map.insert("draft".to_owned(), draft);
    Value::Object(map)
}

pub(crate) fn activity(agent: &str, name: &str, detail: Option<&str>) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("activity".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("activity".to_owned(), Value::from(name.to_owned()));
    if let Some(d) = detail
        && !d.is_empty()
    {
        map.insert("detail".to_owned(), Value::from(d.to_owned()));
    }
    Value::Object(map)
}

pub(crate) fn agent_linked(agent: &str, model: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("agent.linked".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("model".to_owned(), Value::from(model.to_owned()));
    Value::Object(map)
}

pub(crate) fn user_image_upsert(
    agent: &str,
    item: &str,
    parts: &[Value],
    uuid: &str,
    keep: Value,
) -> Value {
    let mut draft = Map::with_capacity(7);
    draft.insert("type".to_owned(), Value::from("message".to_owned()));
    draft.insert("role".to_owned(), Value::from("user".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    if !uuid.is_empty() {
        draft.insert("nativeId".to_owned(), Value::from(uuid.to_owned()));
    }
    draft.insert("parts".to_owned(), Value::from(parts.to_vec()));
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            draft.insert(k, v);
        }
    }
    // TypeScript order: type, role, complete, nativeId?, parts, raw?.
    let mut ordered = Map::with_capacity(draft.len());
    for key in ["type", "role", "complete", "nativeId", "parts", "raw"] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    upsert(agent, item, Value::Object(ordered))
}

pub(crate) fn user_text_upsert(
    agent: &str,
    item: &str,
    parts: &[Value],
    synthetic: bool,
    kind: Option<&str>,
    uuid: &str,
    keep: Value,
) -> Value {
    let mut draft = Map::with_capacity(9);
    draft.insert("type".to_owned(), Value::from("message".to_owned()));
    draft.insert("role".to_owned(), Value::from("user".to_owned()));
    draft.insert("parts".to_owned(), Value::from(parts.to_vec()));
    if synthetic {
        draft.insert("synthetic".to_owned(), Value::Bool(true));
    }
    if let Some(k) = kind {
        let mut origin = Map::with_capacity(1);
        origin.insert("kind".to_owned(), Value::from(k.to_owned()));
        draft.insert("origin".to_owned(), Value::Object(origin));
    }
    draft.insert("complete".to_owned(), Value::Bool(true));
    if !uuid.is_empty() && ace_json::utf16_len(uuid) <= 256 {
        draft.insert("nativeId".to_owned(), Value::from(uuid.to_owned()));
    }
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            draft.insert(k, v);
        }
    }
    // Order: type, role, parts, synthetic?, origin?, complete, nativeId?, raw?.
    let mut ordered = Map::with_capacity(draft.len());
    for key in [
        "type",
        "role",
        "parts",
        "synthetic",
        "origin",
        "complete",
        "nativeId",
        "raw",
    ] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    upsert(agent, item, Value::Object(ordered))
}

pub(crate) fn error_upsert(agent: &str, item: &str, err: &Map, data: &Value) -> Value {
    let mut draft = Map::with_capacity(9);
    draft.insert("type".to_owned(), Value::from("notice".to_owned()));
    draft.insert("level".to_owned(), Value::from("error".to_owned()));
    for key in ["code", "title", "detail", "details"] {
        if let Some(v) = err.get(key) {
            draft.insert(key.to_owned(), v.clone());
        }
    }
    if let Some(v) = err.get("message") {
        draft.insert("text".to_owned(), v.clone());
    }
    draft.insert("complete".to_owned(), Value::Bool(true));
    draft.insert("raw".to_owned(), Value::from(vec![raw(data)]));
    // Order: type, level, code?, title?, detail?, details?, text, complete, raw.
    let mut ordered = Map::with_capacity(draft.len());
    for key in [
        "type", "level", "code", "title", "detail", "details", "text", "complete", "raw",
    ] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    upsert(agent, item, Value::Object(ordered))
}

pub(crate) fn assistant_text_upsert(
    agent: &str,
    item: &str,
    content_text: &str,
    with_native: bool,
    uuid: &str,
    keep: Value,
) -> Value {
    let mut draft = Map::with_capacity(6);
    draft.insert("type".to_owned(), Value::from("message".to_owned()));
    if with_native {
        draft.insert("nativeId".to_owned(), Value::from(uuid.to_owned()));
    }
    draft.insert("role".to_owned(), Value::from("assistant".to_owned()));
    draft.insert(
        "parts".to_owned(),
        Value::from(vec![part_text(content_text)]),
    );
    draft.insert("complete".to_owned(), Value::Bool(true));
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            draft.insert(k, v);
        }
    }
    // Order: type, nativeId?, role, parts, complete, raw?.
    let mut ordered = Map::with_capacity(draft.len());
    for key in ["type", "nativeId", "role", "parts", "complete", "raw"] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    upsert(agent, item, Value::Object(ordered))
}

pub(crate) fn reasoning_upsert(agent: &str, item: &str, thinking: &str, keep: Value) -> Value {
    let mut draft = Map::with_capacity(5);
    draft.insert("type".to_owned(), Value::from("reasoning".to_owned()));
    draft.insert("text".to_owned(), Value::from(thinking.to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            draft.insert(k, v);
        }
    }
    // Order: type, text, complete, raw?.
    let mut ordered = Map::with_capacity(draft.len());
    for key in ["type", "text", "complete", "raw"] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    upsert(agent, item, Value::Object(ordered))
}

pub(crate) fn tool_result_upsert(
    owner: &str,
    item: &str,
    settled_item: bool,
    declined: bool,
    is_error: bool,
    keep: Value,
) -> Value {
    let mut draft = Map::with_capacity(4);
    draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    let mut call = Map::with_capacity(2);
    if !settled_item {
        let status = if declined {
            "declined"
        } else if is_error {
            "failed"
        } else {
            "succeeded"
        };
        call.insert("status".to_owned(), Value::from(status.to_owned()));
    }
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            call.insert(k, v);
        }
    }
    // Order: status?, raw?.
    let mut ordered_call = Map::with_capacity(call.len());
    for key in ["status", "raw"] {
        if let Some(v) = call.remove(key) {
            ordered_call.insert(key.to_owned(), v);
        }
    }
    draft.insert("call".to_owned(), Value::Object(ordered_call));
    upsert(owner, item, Value::Object(draft))
}

pub(crate) fn tool_output_delta(owner: &str, item: &str, output: &str) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("type".to_owned(), Value::from("item.delta".to_owned()));
    map.insert("agent".to_owned(), Value::from(owner.to_owned()));
    map.insert("item".to_owned(), Value::from(item.to_owned()));
    map.insert("field".to_owned(), Value::from("output".to_owned()));
    map.insert("append".to_owned(), Value::from(output.to_owned()));
    Value::Object(map)
}

#[cfg(test)]
mod length_tests {
    use super::user_text_upsert;
    use ace_json::Value;

    #[test]
    fn a_user_draft_native_id_counts_utf16_units_like_string_length() {
        for (uuid, expected) in [
            ("😀".repeat(128), true),
            ("😀".repeat(129), false),
            ("u".repeat(256), true),
            ("u".repeat(257), false),
        ] {
            let draft = user_text_upsert("agent", "item", &[], false, None, &uuid, Value::Null);
            let native = draft.pointer("/draft/nativeId");
            assert_eq!(
                native.is_some(),
                expected,
                "{} UTF-16 units",
                uuid.encode_utf16().count()
            );
        }
    }
}
