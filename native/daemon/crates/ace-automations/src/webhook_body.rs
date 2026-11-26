// SPDX-License-Identifier: Apache-2.0
//! A webhook's JSON body as prompt variables, ported from
//! `packages/automations/src/webhook-body.ts` (ADR 0173, decision 7). Every limit refuses the
//! whole body: a run never starts on part of what the sender sent. Values are JSON.stringify's
//! text and their limit counts UTF-16 units, as JavaScript's `.length` does (rule 17).

use std::collections::BTreeMap;

use ace_json::Value;

pub struct WebhookBodyLimits {
    pub bytes: usize,
    pub depth: usize,
    pub nodes: usize,
    pub leaves: usize,
    pub value_length: usize,
    pub name_length: usize,
}

pub const WEBHOOK_BODY_LIMITS: WebhookBodyLimits = WebhookBodyLimits {
    bytes: 64 * 1024,
    depth: 8,
    nodes: 256,
    leaves: 63,
    value_length: 8192,
    name_length: 128,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookBodyError {
    TooLarge(String),
    BadBody(String),
}

impl WebhookBodyError {
    pub fn code(&self) -> &'static str {
        match self {
            WebhookBodyError::TooLarge(_) => "too_large",
            WebhookBodyError::BadBody(_) => "bad_body",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            WebhookBodyError::TooLarge(message) | WebhookBodyError::BadBody(message) => message,
        }
    }
}

fn refuse(message: impl Into<String>) -> WebhookBodyError {
    WebhookBodyError::BadBody(message.into())
}

fn segment(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `webhookVariables`: `webhook.id` beside one variable per leaf, `body.<path>`.
pub fn webhook_variables(
    body: &[u8],
    delivery_id: &str,
) -> Result<BTreeMap<String, String>, WebhookBodyError> {
    if body.len() > WEBHOOK_BODY_LIMITS.bytes {
        return Err(WebhookBodyError::TooLarge(
            "The body is over 64 KiB.".to_owned(),
        ));
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return Err(refuse("The body isn't JSON."));
    };
    let Ok(value) = ace_json::parse(text) else {
        return Err(refuse("The body isn't JSON."));
    };
    if !matches!(value, Value::Object(_)) {
        return Err(refuse("The body must be a JSON object."));
    }
    let mut variables = BTreeMap::new();
    variables.insert("webhook.id".to_owned(), delivery_id.to_owned());
    let mut nodes = 0usize;
    let mut leaves = 0usize;
    // Iterative, so a deep body cannot exhaust the stack before the depth check refuses it.
    let mut stack: Vec<(&Value, String, usize)> = vec![(&value, "body".to_owned(), 1)];
    while let Some((value, path, depth)) = stack.pop() {
        nodes += 1;
        if nodes > WEBHOOK_BODY_LIMITS.nodes {
            return Err(refuse("The body has more than 256 values."));
        }
        if path.len() > WEBHOOK_BODY_LIMITS.name_length {
            return Err(refuse(format!(
                "A field's path is over {} characters.",
                WEBHOOK_BODY_LIMITS.name_length
            )));
        }
        let children: Option<Vec<(String, &Value)>> = match value {
            Value::Array(items) => Some(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, child)| (index.to_string(), child))
                    .collect(),
            ),
            Value::Object(map) => Some(
                map.iter()
                    .map(|(key, child)| (key.to_string(), child))
                    .collect(),
            ),
            _ => None,
        };
        match children {
            Some(children) => {
                if depth > WEBHOOK_BODY_LIMITS.depth {
                    return Err(refuse("The body is nested more than 8 deep."));
                }
                // Reversed onto the stack, so variables come out in the body's order.
                for (key, child) in children.iter().rev() {
                    if !segment(key) {
                        let shown: String = key.chars().take(64).collect();
                        return Err(refuse(format!(
                            "The key \"{shown}\" isn't letters, digits and _."
                        )));
                    }
                    stack.push((child, format!("{path}.{key}"), depth + 1));
                }
            }
            None => {
                leaves += 1;
                if leaves > WEBHOOK_BODY_LIMITS.leaves {
                    return Err(refuse(format!(
                        "The body has more than {} fields.",
                        WEBHOOK_BODY_LIMITS.leaves
                    )));
                }
                let text = match value {
                    Value::String(text) => text.to_string(),
                    other => ace_json::to_string(other),
                };
                if text.encode_utf16().count() > WEBHOOK_BODY_LIMITS.value_length {
                    return Err(refuse(format!(
                        "A field is over {} characters.",
                        WEBHOOK_BODY_LIMITS.value_length
                    )));
                }
                variables.insert(path, text);
            }
        }
    }
    Ok(variables)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(body: &str) -> Result<BTreeMap<String, String>, WebhookBodyError> {
        webhook_variables(body.as_bytes(), "evt_1")
    }

    fn fields(count: usize) -> String {
        let entries: Vec<String> = (0..count)
            .map(|index| format!("\"f{index}\":{index}"))
            .collect();
        format!("{{{}}}", entries.join(","))
    }

    fn nested(depth: usize) -> String {
        if depth == 1 {
            "{\"leaf\":1}".to_owned()
        } else {
            format!("{{\"a\":{}}}", nested(depth - 1))
        }
    }

    #[test]
    fn makes_each_leaf_a_body_variable_with_the_delivery_id_beside_them() {
        let result = read(
            r#"{"deploy":{"env":"prod","ok":true,"attempts":3,"note":null},"tags":["a","b"]}"#,
        )
        .expect("body");
        let expected: BTreeMap<String, String> = [
            ("webhook.id", "evt_1"),
            ("body.deploy.env", "prod"),
            ("body.deploy.ok", "true"),
            ("body.deploy.attempts", "3"),
            ("body.deploy.note", "null"),
            ("body.tags.0", "a"),
            ("body.tags.1", "b"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
        assert_eq!(result, expected);
    }

    #[test]
    fn accepts_an_empty_object() {
        assert_eq!(read("{}").expect("body").len(), 1);
    }

    #[test]
    fn refuses_bodies_that_are_not_one_json_object() {
        for body in ["", "not json", "[1,2]", "\"text\"", "42", "null"] {
            assert!(read(body).is_err(), "{body}");
        }
    }

    #[test]
    fn refuses_bytes_that_are_not_utf8() {
        assert_eq!(
            webhook_variables(&[0x7b, 0xff, 0x7d], "evt_1"),
            Err(refuse("The body isn't JSON."))
        );
    }

    #[test]
    fn refuses_a_body_over_the_byte_limit_instead_of_reading_part_of_it() {
        let body = format!("{{\"text\":\"{}\"}}", "x".repeat(WEBHOOK_BODY_LIMITS.bytes));
        assert_eq!(read(&body).expect_err("too large").code(), "too_large");
    }

    #[test]
    fn refuses_nesting_past_the_depth_limit() {
        assert!(read(&nested(WEBHOOK_BODY_LIMITS.depth)).is_ok());
        assert!(read(&nested(WEBHOOK_BODY_LIMITS.depth + 1)).is_err());
    }

    #[test]
    fn refuses_more_leaves_than_the_prompt_can_hold_rather_than_dropping_some() {
        assert!(read(&fields(WEBHOOK_BODY_LIMITS.leaves)).is_ok());
        assert!(read(&fields(WEBHOOK_BODY_LIMITS.leaves + 1)).is_err());
    }

    #[test]
    fn refuses_more_values_than_the_node_limit_even_when_few_are_leaves() {
        let entries: Vec<String> = (0..WEBHOOK_BODY_LIMITS.nodes)
            .map(|index| format!("\"e{index}\":{{}}"))
            .collect();
        assert!(read(&format!("{{{}}}", entries.join(","))).is_err());
    }

    #[test]
    fn refuses_a_value_longer_than_a_variable_can_hold_rather_than_clipping_it() {
        assert!(
            read(&format!(
                "{{\"text\":\"{}\"}}",
                "x".repeat(WEBHOOK_BODY_LIMITS.value_length)
            ))
            .is_ok()
        );
        assert!(
            read(&format!(
                "{{\"text\":\"{}\"}}",
                "x".repeat(WEBHOOK_BODY_LIMITS.value_length + 1)
            ))
            .is_err()
        );
        // The value limit counts UTF-16 units: 4,097 astral characters are 8,194 units.
        assert!(read(&format!("{{\"text\":\"{}\"}}", "\u{1F600}".repeat(4097))).is_err());
    }

    #[test]
    fn refuses_keys_a_prompt_variable_cannot_name() {
        for key in ["pull-request", "", "a.b", "\u{e9}moji"] {
            let body = format!("{{\"{key}\":1}}");
            assert!(read(&body).is_err(), "{key}");
        }
    }

    #[test]
    fn refuses_a_path_longer_than_a_variable_name_can_be() {
        assert!(read(&format!("{{\"{}\":1}}", "k".repeat(130))).is_err());
    }
}
