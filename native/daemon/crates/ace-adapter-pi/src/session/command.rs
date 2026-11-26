// SPDX-License-Identifier: Apache-2.0
//! A send's native commands: `nativeCommandInputs` (`packages/commands/src/native-command-inputs.ts`)
//! and the protocol parts as the raw JSON `piInput` reads (`input.ts`).
//!
//! Pi is a prefix-only harness: one native command per admission, with the complete message as
//! context. Reserved control commands are refused by `input::pi_input` itself.

use ace_json::{JsString, Map, Value};
use ace_protocol::generated::ContentPart;

/// Why a send cannot become native commands. The message is the TypeScript's own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiCommandError {
    #[error("Unresolved command mention")]
    UnresolvedMention,
    #[error("Pi input could not be encoded")]
    Encoding,
}

/// The protocol parts as `JSON.stringify(part)` values, which is what `piInput` reads.
pub fn content_part_values(input: &[ContentPart]) -> Result<Vec<Value>, PiCommandError> {
    input
        .iter()
        .map(|part| {
            let text = ace_json::ser::to_string(part).map_err(|_| PiCommandError::Encoding)?;
            ace_json::parse(&text).map_err(|_| PiCommandError::Encoding)
        })
        .collect()
}

fn kind(part: &Value) -> &str {
    part.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn text<'a>(part: &'a Value, key: &str) -> Option<&'a str> {
    part.get(key).and_then(Value::as_str)
}

/// `nativeCommandInputs`: one admission per slash command, each carrying the whole message as
/// context; a message with no command is one admission as sent.
pub fn native_command_inputs(input: &[Value]) -> Result<Vec<Vec<Value>>, PiCommandError> {
    let mut commands: Vec<String> = Vec::new();
    let mut context: Vec<Value> = Vec::new();
    for part in input {
        if kind(part) != "mention" {
            context.push(part.clone());
            continue;
        }
        let invocation = part
            .get("invocation")
            .and_then(Value::as_object)
            .filter(|invocation| invocation.get("type").and_then(Value::as_str) == Some("slash"))
            .ok_or(PiCommandError::UnresolvedMention)?;
        let name = invocation
            .get("name")
            .and_then(Value::as_str)
            .ok_or(PiCommandError::UnresolvedMention)?;
        let arguments = text(part, "arguments").unwrap_or_default();
        commands.push(if arguments.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {arguments}")
        });
        let placeholder = format!("[{}]", text(part, "name").unwrap_or_default());
        if context.last().is_some_and(|last| kind(last) == "text") {
            if let Some(Value::Object(last)) = context.last_mut() {
                let joined = format!(
                    "{}{placeholder}",
                    last.get("text").and_then(Value::as_str).unwrap_or_default()
                );
                last.insert("text", Value::String(JsString::from(joined)));
            }
        } else {
            let mut map = Map::with_capacity(2);
            map.insert("type", Value::from("text"));
            map.insert("text", Value::from(placeholder.as_str()));
            context.push(Value::Object(map));
        }
    }
    if commands.is_empty() {
        return Ok(vec![input.to_vec()]);
    }
    Ok(commands
        .into_iter()
        .map(|command| {
            let mut parts = Vec::with_capacity(context.len() + 1);
            let mut lead = Map::with_capacity(2);
            lead.insert("type", Value::from("text"));
            lead.insert(
                "text",
                Value::from(format!("{command}\n\nMessage context:\n").as_str()),
            );
            parts.push(Value::Object(lead));
            parts.extend(context.iter().cloned());
            parts
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(value: Value) -> Value {
        value
    }

    fn text_part(text: &str) -> Value {
        part(Value::Object({
            let mut map = Map::with_capacity(2);
            map.insert("type", Value::from("text"));
            map.insert("text", Value::from(text));
            map
        }))
    }

    fn mention(name: &str, arguments: &str) -> Value {
        part(Value::Object({
            let mut map = Map::with_capacity(5);
            map.insert("type", Value::from("mention"));
            map.insert("name", Value::from("Skill"));
            map.insert("arguments", Value::from(arguments));
            let mut invocation = Map::with_capacity(2);
            invocation.insert("type", Value::from("slash"));
            invocation.insert("name", Value::from(name));
            map.insert("invocation", Value::Object(invocation));
            map
        }))
    }

    #[test]
    fn a_message_without_a_command_is_one_admission_as_sent() {
        let input = vec![text_part("hello")];
        assert_eq!(native_command_inputs(&input).expect("inputs"), vec![input]);
    }

    #[test]
    fn each_slash_command_is_one_admission_carrying_the_message_after_the_placeholder() {
        let input = vec![
            text_part("before"),
            mention("review", "the diff"),
            text_part(" after"),
        ];
        let inputs = native_command_inputs(&input).expect("inputs");
        assert_eq!(inputs.len(), 1);
        assert_eq!(
            inputs[0][0].get("text").and_then(Value::as_str),
            Some("/review the diff\n\nMessage context:\n")
        );
        assert_eq!(
            inputs[0]
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec![
                "/review the diff\n\nMessage context:\n",
                "before[Skill]",
                " after"
            ]
        );
    }

    #[test]
    fn a_mention_without_a_slash_invocation_is_refused() {
        let input = vec![part(Value::Object({
            let mut map = Map::with_capacity(2);
            map.insert("type", Value::from("mention"));
            map.insert("name", Value::from("Skill"));
            map
        }))];
        assert_eq!(
            native_command_inputs(&input).unwrap_err(),
            PiCommandError::UnresolvedMention
        );
    }
}
