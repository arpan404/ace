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

/// The origin a stored text is, when it parses as a `MessageOrigin`.
pub fn message_origin(stored: &str) -> Option<Value> {
    let value = ace_json::parse(stored).ok()?;
    let kind = value.get("kind").and_then(Value::as_str)?;
    KINDS.contains(&kind).then_some(value)
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

    fn acjson(value: &Value) -> String {
        ace_json::to_string(value)
    }
}
