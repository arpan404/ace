// SPDX-License-Identifier: Apache-2.0
//! An accepted input's origin (`input-journal.ts:23`-`:41`, E5.4b). Native metadata supplies
//! identity only; origin comes from ace's own command, never from provider content.

use ace_json::Value;

/// The origin kinds `MessageOrigin` holds (`packages/protocol/src/items.ts:84`).
const KINDS: [&str; 13] = [
    "person",
    "interaction_answer",
    "subagent_result",
    "handoff",
    "spawn",
    "parent_agent",
    "restart",
    "limit_resume",
    "queue",
    "steer",
    "automation",
    "schedule",
    "background_completion",
];

/// The origin a stored text is, when it parses as a `MessageOrigin`: the schema's keys in its
/// order, unknown keys dropped, as zod's parse writes them (the event bytes must match).
pub fn message_origin(stored: &str) -> Option<Value> {
    let value = ace_json::parse(stored).ok()?;
    let source = value.as_object()?;
    let kind = source.get("kind")?.as_str()?;
    if !KINDS.contains(&kind) {
        return None;
    }
    let mut origin = ace_json::Map::new();
    origin.insert("kind", Value::from(kind));
    if let Some(client) = source.get("client") {
        let client = client.as_object()?;
        let mut kept = ace_json::Map::new();
        kept.insert(
            "grantId",
            Value::from(bounded(client.get("grantId")?, 128)?.as_str()),
        );
        kept.insert(
            "name",
            Value::from(bounded(client.get("name")?, 256)?.as_str()),
        );
        origin.insert("client", Value::Object(kept));
    }
    for key in ["commandId", "interactionId", "parentThreadId"] {
        if let Some(field) = source.get(key) {
            origin.insert(key, Value::from(non_empty(field)?.as_str()));
        }
    }
    if let Some(threads) = source.get("threadIds") {
        let threads = threads.as_array()?;
        let mut kept = Vec::with_capacity(threads.len());
        for thread in threads {
            kept.push(Value::from(non_empty(thread)?.as_str()));
        }
        origin.insert("threadIds", Value::Array(kept.into()));
    }
    if let Some(role) = source.get("role") {
        origin.insert("role", Value::from(role.as_str()?.to_owned()));
    }
    for key in ["from", "to"] {
        if let Some(model) = source.get(key) {
            origin.insert(key, handoff_model(model)?);
        }
    }
    if let Some(sources) = source.get("sources") {
        let sources = sources.as_array()?;
        if sources.len() > 8 {
            return None;
        }
        let mut kept = Vec::with_capacity(sources.len());
        for model in sources {
            kept.push(handoff_model(model)?);
        }
        origin.insert("sources", Value::Array(kept.into()));
    }
    if let Some(lossy) = source.get("lossy") {
        origin.insert("lossy", Value::Bool(lossy.as_bool()?));
    }
    if let Some(fresh) = source.get("freshSession") {
        if fresh.as_bool() != Some(true) {
            return None;
        }
        origin.insert("freshSession", Value::Bool(true));
    }
    if let Some(after_exit) = source.get("afterExit") {
        origin.insert("afterExit", Value::Bool(after_exit.as_bool()?));
    }
    if let Some(via) = source.get("via") {
        let via = via.as_object()?;
        let mut kept = ace_json::Map::new();
        kept.insert("threadId", Value::from(non_empty(via.get("threadId")?)?));
        if let Some(title) = via.get("title") {
            kept.insert("title", Value::from(bounded(title, 256)?.to_owned()));
        }
        origin.insert("via", Value::Object(kept));
    }
    Some(Value::Object(origin))
}

/// A non-empty string (`z.string().min(1)`).
fn non_empty(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (!text.is_empty()).then(|| text.to_owned())
}

/// A non-empty string of at most `max` UTF-16 units.
fn bounded(value: &Value, max: usize) -> Option<String> {
    let text = non_empty(value)?;
    (text.encode_utf16().count() <= max).then_some(text)
}

/// `{ provider, model? }` (`HandoffModel`), rebuilt in schema order.
fn handoff_model(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let provider = object.get("provider")?.as_str()?;
    const PROVIDERS: [&str; 7] = [
        "claude",
        "codex",
        "opencode",
        "cursor",
        "antigravity",
        "acp",
        "pi",
    ];
    if !PROVIDERS.contains(&provider) {
        return None;
    }
    let mut kept = ace_json::Map::new();
    kept.insert("provider", Value::from(provider));
    if let Some(model) = object.get("model") {
        kept.insert("model", Value::from(model.as_str()?.to_owned()));
    }
    Some(Value::Object(kept))
}

/// `personInput`: the person's own words (typed, queued or steered).
pub fn person_input(origin: &Value) -> bool {
    matches!(
        origin.get("kind").and_then(Value::as_str),
        Some("person" | "queue" | "steer")
    )
}

/// `inputOrigin(command)`: the journal's origin for an accepted create or send.
pub fn input_origin(command: &Value) -> Value {
    let id = command
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(payload) = command.get("payload") else {
        return person(id);
    };
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind != "thread.create" && kind != "thread.send" {
        return person(id);
    }
    // An explicit origin wins, with the command that carried it.
    if let Some(explicit) = payload.get("origin").filter(|origin| origin.is_object()) {
        let mut origin = explicit.clone();
        if let Some(object) = origin.as_object_mut() {
            object.insert("commandId", Value::from(id));
        }
        return origin;
    }
    let trigger = payload.get("trigger").and_then(Value::as_str);
    let kind = match trigger {
        None | Some("") | Some("user") | Some("unknown") => "person",
        Some("goal") => "parent_agent",
        Some(trigger) => trigger,
    };
    let mut origin = ace_json::Map::new();
    origin.insert("kind", Value::from(kind));
    origin.insert("commandId", Value::from(id));
    Value::Object(origin)
}

fn person(id: &str) -> Value {
    let mut origin = ace_json::Map::new();
    origin.insert("kind", Value::from("person"));
    origin.insert("commandId", Value::from(id));
    Value::Object(origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(text: &str) -> Value {
        ace_json::parse(text).expect("a command")
    }

    #[test]
    fn a_trigger_names_its_origin_and_a_goal_is_a_parent_agents_work() {
        assert_eq!(
            acjson(&input_origin(&command(
                r#"{"id":"c1","payload":{"type":"thread.send","trigger":"goal"}}"#
            ))),
            r#"{"kind":"parent_agent","commandId":"c1"}"#
        );
        assert_eq!(
            acjson(&input_origin(&command(
                r#"{"id":"c2","payload":{"type":"thread.create","trigger":"user"}}"#
            ))),
            r#"{"kind":"person","commandId":"c2"}"#
        );
        assert_eq!(
            acjson(&input_origin(&command(
                r#"{"id":"c3","payload":{"type":"thread.send","trigger":"subagent_result"}}"#
            ))),
            r#"{"kind":"subagent_result","commandId":"c3"}"#
        );
    }

    #[test]
    fn an_explicit_origin_wins_and_keeps_its_key_order() {
        let origin = input_origin(&command(
            r#"{"id":"c4","payload":{"type":"thread.send","origin":{"kind":"handoff","interactionId":"i"},"trigger":"goal"}}"#,
        ));
        assert_eq!(
            acjson(&origin),
            r#"{"kind":"handoff","interactionId":"i","commandId":"c4"}"#
        );
        assert!(!person_input(&origin));
    }

    #[test]
    fn a_queue_command_that_is_no_create_or_send_is_the_persons_but_a_queue_entry_is_not() {
        let origin = input_origin(&command(
            r#"{"id":"c5","payload":{"type":"thread.archive"}}"#,
        ));
        assert_eq!(acjson(&origin), r#"{"kind":"person","commandId":"c5"}"#);
        let queued = message_origin(r#"{"kind":"queue","commandId":"c5"}"#).expect("an origin");
        assert!(person_input(&queued));
        assert!(!person_input(
            &message_origin(r#"{"kind":"handoff"}"#).expect("an origin")
        ));
    }

    #[test]
    fn a_stored_origin_keeps_the_schemas_order_and_drops_unknown_keys() {
        // `MessageOrigin.parse`: schema order, unknown keys stripped, nested models rebuilt.
        let stored = r#"{"sources":[{"provider":"claude"}],"kind":"handoff","lossy":true,"commandId":"c1","unknown":1,"from":{"model":"m","provider":"codex"},"threadIds":["t"],"freshSession":true}"#;
        let origin = message_origin(stored).expect("an origin");
        assert_eq!(
            acjson(&origin),
            r#"{"kind":"handoff","commandId":"c1","threadIds":["t"],"from":{"provider":"codex","model":"m"},"sources":[{"provider":"claude"}],"lossy":true,"freshSession":true}"#
        );
        // A value the schema refuses is not an origin.
        assert!(message_origin(r#"{"kind":"handoff","freshSession":false}"#).is_none());
        assert!(message_origin(r#"{"kind":"person","commandId":""}"#).is_none());
    }

    fn acjson(value: &Value) -> String {
        ace_json::to_string(value)
    }
}
