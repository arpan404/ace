// SPDX-License-Identifier: Apache-2.0
//! The approval target a provider's own gate shows for an ace tool call, ported from
//! `action-target.ts` and the registry's `action()`.
//!
//! ace never gates its own tools: this shape only tells the provider what a call would do, so its
//! permission mode can decide. The scope keys and the measurement/listing overrides are the
//! TypeScript's, and the description is bounded to 2048 UTF-16 units as `.slice(0, 2048)` is.

use ace_json::{JsString, Map, Value};

use crate::tool_names::bare_tool_name;

/// The input keys a person needs to recognize the target, in the TypeScript's order.
const SCOPE_KEYS: [&str; 15] = [
    "threadId",
    "workspaceId",
    "provider",
    "model",
    "role",
    "streamId",
    "simId",
    "appId",
    "url",
    "ref",
    "action",
    "interaction",
    "sessionId",
    "tabId",
    "key",
];

/// `describeAceAction`: the target's JSON, in the protocol's key order.
pub fn describe_ace_action(
    tool: &str,
    description: &str,
    risk_class: Option<&str>,
    input: &Value,
) -> Value {
    let bare = bare_tool_name(tool);
    let mut risk = risk_class.unwrap_or("external-effect").to_owned();
    let object = input.as_object();
    // Measurement reads are safe to approve as view operations; a nested input is an effect.
    if matches!(bare.as_str(), "screen_measure" | "browser_measure")
        && let Some(object) = object
    {
        let field = if bare == "screen_measure" {
            "action"
        } else {
            "interaction"
        };
        risk = if object.get(field).is_none_or(Value::is_null) {
            "read-only".to_owned()
        } else {
            "external-effect".to_owned()
        };
    }
    // Listing history reads; moving through it navigates.
    if bare == "browser_history"
        && let Some(object) = object
    {
        risk = if object.get("direction").is_none_or(Value::is_null) {
            "read-only".to_owned()
        } else {
            "external-effect".to_owned()
        };
    }
    // Listing tabs or installed extensions reads; the other actions change the browser.
    if bare == "browser_tabs"
        && let Some(object) = object
    {
        let action = object
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("list");
        if action == "list" {
            risk = "read-only".to_owned();
        }
    }
    if bare == "browser_settings"
        && let Some(object) = object
        && object.get("action").and_then(Value::as_str) == Some("extensions")
    {
        risk = "read-only".to_owned();
    }
    // `Object.entries(input).filter(…scopeKeys…)`: the input's own key order.
    let scope = match object {
        Some(object) => {
            let mut kept = Map::new();
            for (key, value) in object {
                if SCOPE_KEYS.contains(&key.as_str()) {
                    kept.insert(key.as_str(), value.clone());
                }
            }
            kept
        }
        None => Map::new(),
    };
    let mut text = description.to_owned();
    if !scope.is_empty() {
        text.push_str(&format!(
            " Target: {}.",
            ace_json::to_string(&Value::Object(scope))
        ));
    }
    let text = truncate_utf16(&text, 2048);
    let access = match risk.as_str() {
        "read-only" => "read",
        "agent-execution" => "execute",
        _ => "write",
    };
    let mut map = Map::with_capacity(6);
    map.insert("tool", Value::from(tool));
    map.insert("input", input.clone());
    map.insert("origin", Value::from("ace"));
    map.insert("riskClass", Value::String(JsString::from(risk.as_str())));
    map.insert("access", Value::from(access));
    map.insert("description", Value::String(JsString::from(text.as_str())));
    Value::Object(map)
}

/// `.slice(0, units)` over UTF-16 units: a cut surrogate pair becomes U+FFFD, as JS text does.
fn truncate_utf16(text: &str, units: usize) -> String {
    let encoded: Vec<u16> = text.encode_utf16().collect();
    if encoded.len() <= units {
        return text.to_owned();
    }
    String::from_utf16_lossy(&encoded[..units])
}

#[cfg(test)]
mod tests {
    // Ported from `action-target.ts`'s contract and the approval metadata `actions.ts` builds.
    use super::*;
    use ace_json::parse;

    fn json(text: &str) -> Value {
        parse(text).expect("json")
    }

    #[test]
    fn a_read_only_call_is_access_read_with_the_scope_keys_in_input_order() {
        let target = describe_ace_action(
            "thread_read",
            "Read a thread",
            Some("read-only"),
            &json("{\"threadId\":\"t\",\"secret\":1,\"agentId\":\"a\"}"),
        );
        assert_eq!(
            target.get("tool").and_then(Value::as_str),
            Some("thread_read")
        );
        assert_eq!(target.get("origin").and_then(Value::as_str), Some("ace"));
        assert_eq!(
            target.get("riskClass").and_then(Value::as_str),
            Some("read-only")
        );
        assert_eq!(target.get("access").and_then(Value::as_str), Some("read"));
        assert_eq!(
            target.get("description").and_then(Value::as_str),
            Some("Read a thread Target: {\"threadId\":\"t\"}.")
        );
        assert_eq!(
            ace_json::to_string(&target),
            "{\"tool\":\"thread_read\",\"input\":{\"threadId\":\"t\",\"secret\":1,\"agentId\":\"a\"},\
             \"origin\":\"ace\",\"riskClass\":\"read-only\",\"access\":\"read\",\
             \"description\":\"Read a thread Target: {\\\"threadId\\\":\\\"t\\\"}.\"}"
        );
    }

    #[test]
    fn a_measurement_is_a_read_without_nested_work_and_an_effect_with_it() {
        for (tool, field) in [
            ("screen_measure", "action"),
            ("browser_measure", "interaction"),
        ] {
            let read = describe_ace_action(tool, "Measure", Some("read-only"), &json("{}"));
            assert_eq!(
                read.get("riskClass").and_then(Value::as_str),
                Some("read-only")
            );
            assert_eq!(read.get("access").and_then(Value::as_str), Some("read"));
            let effect = describe_ace_action(
                tool,
                "Measure",
                Some("read-only"),
                &json(&format!("{{\"{field}\":{{\"tap\":true}}}}")),
            );
            assert_eq!(
                effect.get("riskClass").and_then(Value::as_str),
                Some("external-effect"),
                "{tool}"
            );
            assert_eq!(effect.get("access").and_then(Value::as_str), Some("write"));
        }
    }

    #[test]
    fn listing_history_tabs_and_extensions_reads_and_moving_changes() {
        let history = describe_ace_action(
            "browser_history",
            "History",
            Some("external-effect"),
            &json("{}"),
        );
        assert_eq!(
            history.get("riskClass").and_then(Value::as_str),
            Some("read-only")
        );
        let navigates = describe_ace_action(
            "browser_history",
            "History",
            Some("external-effect"),
            &json("{\"direction\":\"back\"}"),
        );
        assert_eq!(
            navigates.get("riskClass").and_then(Value::as_str),
            Some("external-effect")
        );
        let tabs =
            describe_ace_action("browser_tabs", "Tabs", Some("external-effect"), &json("{}"));
        assert_eq!(
            tabs.get("riskClass").and_then(Value::as_str),
            Some("read-only")
        );
        let opens = describe_ace_action(
            "browser_tabs",
            "Tabs",
            Some("external-effect"),
            &json("{\"action\":\"open\"}"),
        );
        assert_eq!(
            opens.get("riskClass").and_then(Value::as_str),
            Some("external-effect")
        );
        let extensions = describe_ace_action(
            "browser_settings",
            "Settings",
            Some("external-effect"),
            &json("{\"action\":\"extensions\"}"),
        );
        assert_eq!(
            extensions.get("riskClass").and_then(Value::as_str),
            Some("read-only")
        );
        let changes = describe_ace_action(
            "browser_settings",
            "Settings",
            Some("external-effect"),
            &json("{\"action\":\"clear\"}"),
        );
        assert_eq!(
            changes.get("riskClass").and_then(Value::as_str),
            Some("external-effect")
        );
    }

    #[test]
    fn an_agent_execution_is_access_execute_and_an_unknown_risk_is_write() {
        let execution = describe_ace_action(
            "delegate",
            "Delegate",
            Some("agent-execution"),
            &json("{\"task\":\"x\"}"),
        );
        assert_eq!(
            execution.get("access").and_then(Value::as_str),
            Some("execute")
        );
        let unknown = describe_ace_action("ace_echo", "Echo", None, &Value::Null);
        assert_eq!(
            unknown.get("riskClass").and_then(Value::as_str),
            Some("external-effect")
        );
        assert_eq!(unknown.get("access").and_then(Value::as_str), Some("write"));
        assert_eq!(
            unknown.get("description").and_then(Value::as_str),
            Some("Echo")
        );
    }

    #[test]
    fn the_description_is_bounded_in_utf16_units() {
        let description = "x".repeat(2048);
        let target = describe_ace_action("ace_echo", &description, Some("read-only"), &json("{}"));
        assert_eq!(
            target
                .get("description")
                .and_then(Value::as_str)
                .map(str::len),
            Some(2048)
        );
        let long = format!("{} Target: {{\"threadId\":\"t\"}}.", "x".repeat(2040));
        let target = describe_ace_action(
            "ace_echo",
            &long,
            Some("read-only"),
            &json("{\"threadId\":\"t\"}"),
        );
        assert_eq!(
            target
                .get("description")
                .and_then(Value::as_str)
                .map(str::len),
            Some(2048)
        );
    }
}
