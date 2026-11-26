// SPDX-License-Identifier: Apache-2.0
//! `nativeCommandInputs` (`packages/commands/src/native-command-inputs.ts:3`, E5.4b). Prefix-only
//! harnesses receive one native command per admission, with the complete message as context.
//!
//! Both provider input modules and the engine's input journal call this, so the copy lives in
//! the one crate every adapter already depends on. Parts arrive as `ace_json` values, as the
//! stored command carries them.

use ace_json::Value;
use thiserror::Error;

/// A selected command mention with no slash invocation: the caller cannot render it natively.
#[derive(Debug, Error)]
pub enum CommandInputsError {
    #[error("Unresolved command mention")]
    UnresolvedMention,
}

/// The text of a part, when it is a text part.
fn text_of(part: &Value) -> Option<&str> {
    if part.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    part.get("text").and_then(Value::as_str)
}

/// One admission per selected command, with the message as context.
pub fn native_command_inputs(input: &[Value]) -> Result<Vec<Vec<Value>>, CommandInputsError> {
    let mut commands: Vec<String> = Vec::new();
    let mut context: Vec<Value> = Vec::new();
    for part in input {
        if part.get("type").and_then(Value::as_str) != Some("mention") {
            context.push(part.clone());
            continue;
        }
        let invocation = part.get("invocation");
        if invocation
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            != Some("slash")
        {
            return Err(CommandInputsError::UnresolvedMention);
        }
        let name = invocation
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = part
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        commands.push(if arguments.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {arguments}")
        });
        let chip = format!(
            "[{}]",
            part.get("name").and_then(Value::as_str).unwrap_or_default()
        );
        match context.last_mut() {
            Some(last) if text_of(last).is_some() => {
                if let Some(Value::String(text)) = last.get_mut("text") {
                    text.push_str(&chip);
                }
            }
            _ => {
                let mut block = ace_json::Map::new();
                block.insert("type", Value::from("text"));
                block.insert("text", Value::from(chip.as_str()));
                context.push(Value::Object(block));
            }
        }
    }
    if commands.is_empty() {
        return Ok(vec![input.to_vec()]);
    }
    Ok(commands
        .into_iter()
        .map(|command| {
            let mut block = ace_json::Map::new();
            block.insert("type", Value::from("text"));
            block.insert(
                "text",
                Value::from(format!("{command}\n\nMessage context:\n").as_str()),
            );
            let mut parts = vec![Value::Object(block)];
            parts.extend(context.iter().cloned());
            parts
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(text: &str) -> Value {
        ace_json::parse(text).expect("a parts array")
    }

    #[test]
    fn a_message_with_no_mention_is_one_admission() {
        let input = parts(r#"[{"type":"text","text":"hi"}]"#);
        let admissions = native_command_inputs(input.as_array().unwrap()).unwrap();
        assert_eq!(admissions, vec![input.as_array().unwrap().to_vec()]);
    }

    #[test]
    fn one_slash_mention_builds_its_command_and_keeps_the_message_as_context() {
        // The mention's name becomes a text chip appended to the message it followed.
        let input = parts(
            r#"[{"type":"text","text":"please "},{"type":"mention","entryId":"e","kind":"command","name":"Review","arguments":"now","invocation":{"type":"slash","name":"review"}}]"#,
        );
        let admissions = native_command_inputs(input.as_array().unwrap()).unwrap();
        assert_eq!(admissions.len(), 1);
        let texts: Vec<&str> = admissions[0].iter().filter_map(text_of).collect();
        assert_eq!(
            texts,
            vec!["/review now\n\nMessage context:\n", "please [Review]"]
        );
    }

    #[test]
    fn a_mention_without_a_slash_invocation_is_refused_with_its_message() {
        let input = parts(r#"[{"type":"mention","entryId":"e","kind":"skill","name":"Review"}]"#);
        let error = native_command_inputs(input.as_array().unwrap()).unwrap_err();
        assert_eq!(error.to_string(), "Unresolved command mention");
    }
}
