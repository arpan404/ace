// SPDX-License-Identifier: Apache-2.0
//! `PortableHandoff` (`packages/protocol/src/thread-transitions.ts:97`) as the handoff envelope
//! validates it (E5.4b). `ace-protocol` has no generated type for it yet (E5.9's handoff port adds
//! one), so the schema's requirements are checked here: required keys, their types and bounds,
//! with unknown keys allowed as zod allows them.

use ace_json::Value;

/// `PortableHandoff.safeParse(value).success` (`packages/protocol/src/thread-transitions.ts:97`).
///
/// `ace-protocol` has no generated `PortableHandoff` yet (E5.9's handoff port adds it), so the
/// schema's requirements are checked here: required keys, their types and their bounds, with
/// unknown keys allowed as zod allows them.
pub fn valid_portable_handoff(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let is_int_at_least = |key: &str, minimum: f64| {
        object
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(|number| number.fract() == 0.0 && number >= minimum)
    };
    object.get("version").and_then(Value::as_f64) == Some(1.0)
        && object
            .get("sourceThreadId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && object.get("lossy").and_then(Value::as_bool) == Some(true)
        && matches!(
            object.get("policy").and_then(Value::as_str),
            Some("recent-complete-items" | "conversation-first")
        )
        && is_int_at_least("throughSeq", 0.0)
        && is_int_at_least("omittedItems", 0.0)
        && object.get("since").is_none_or(|since| {
            since
                .as_f64()
                .is_some_and(|number| number.fract() == 0.0 && number >= 0.0)
        })
        && matches!(
            object.get("limitations").and_then(Value::as_str),
            Some(
                "Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments."
            )
        )
        && origin_ok(object.get("origin"))
        && sources_ok(object.get("sources"))
        && excerpts_ok(object.get("excerpts"))
        && history_ok(object.get("history"))
}

const PROVIDERS: [&str; 7] = [
    "claude",
    "codex",
    "opencode",
    "cursor",
    "antigravity",
    "acp",
    "pi",
];

fn provider_ok(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|provider| PROVIDERS.contains(&provider))
}

fn short_string(value: Option<&Value>, max: usize) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty() && text.encode_utf16().count() <= max)
}

fn origin_ok(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(origin) => {
            let Some(object) = origin.as_object() else {
                return false;
            };
            provider_ok(object.get("provider"))
                && match object.get("backend") {
                    None => true,
                    Some(backend) => short_string(Some(backend), 256),
                }
        }
    }
}

fn sources_ok(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(sources) => {
            let Some(items) = sources.as_array() else {
                return false;
            };
            items.len() <= 8
                && items.iter().all(|source| {
                    let Some(object) = source.as_object() else {
                        return false;
                    };
                    provider_ok(object.get("provider"))
                        && match object.get("model") {
                            None => true,
                            Some(model) => short_string(Some(model), 256),
                        }
                })
        }
    }
}

fn excerpts_ok(value: Option<&Value>) -> bool {
    let Some(excerpts) = value.and_then(Value::as_array) else {
        return false;
    };
    excerpts.len() <= 200
        && excerpts.iter().all(|excerpt| {
            let Some(object) = excerpt.as_object() else {
                return false;
            };
            let citation = object.get("citation").and_then(Value::as_object);
            let text_ok = object
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.encode_utf16().count() <= 8192);
            text_ok
                && citation.is_some_and(|citation| {
                    short_string(citation.get("threadId"), usize::MAX)
                        && short_string(citation.get("itemId"), usize::MAX)
                })
        })
}

fn history_ok(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    object.get("type").and_then(Value::as_str) == Some("items.page")
        && match object.get("tool") {
            None => true,
            Some(tool) => tool.as_str() == Some("handoff_read"),
        }
        && short_string(object.get("threadId"), usize::MAX)
        && object
            .get("before")
            .and_then(Value::as_f64)
            .is_some_and(|number| number.fract() == 0.0 && number > 0.0)
        && object.get("limit").and_then(Value::as_f64) == Some(50.0)
}
