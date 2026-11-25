// SPDX-License-Identifier: Apache-2.0
//! The input a turn or a steer carries, in Codex's own shape (`native-input.ts`).
//! Every part the engine hands a send is mapped here, before admission, so the
//! request the session pushes already holds the bytes Codex reads.

use ace_json::{Map, Value};

/// `nativeInput(parts)`: the turn's `input` array.
///
/// The parts arrive as the engine's own `ContentPart` JSON, which is also what
/// `TurnStartParams.input` carries except for ace's file references: Codex
/// documents mention items only for `app://` connectors and does not show them
/// to the model as text, so a local file without an image type travels as its
/// path (and its text content, when it has any).
pub fn native_input(parts: &[Value]) -> Result<Value, String> {
    let mut input = Vec::with_capacity(parts.len());
    for part in parts {
        input.push(native_part(part)?);
    }
    Ok(Value::Array(input.into()))
}

fn native_part(part: &Value) -> Result<Value, String> {
    match part.get("type").and_then(Value::as_str) {
        Some("mention") => mention(part),
        Some("text") => {
            let mut text = Map::new();
            text.insert("type", Value::from("text"));
            text.insert("text", Value::from(text_of(part, "text")));
            text.insert("text_elements", Value::Array(Vec::new().into()));
            Ok(Value::Object(text))
        }
        Some("image") => {
            let mut image = Map::new();
            image.insert("type", Value::from("image"));
            image.insert("url", Value::from(text_of(part, "url")));
            Ok(Value::Object(image))
        }
        _ => file(part),
    }
}

/// A mention travels as the invocation it resolved to (`skill` or `mention`).
fn mention(part: &Value) -> Result<Value, String> {
    let invocation = part.get("invocation");
    let kind = invocation
        .and_then(|invocation| invocation.get("type"))
        .and_then(Value::as_str)
        .filter(|kind| *kind == "skill" || *kind == "mention")
        .ok_or_else(|| "Unresolved Codex mention".to_owned())?;
    let mut resolved = Map::new();
    resolved.insert("type", Value::from(kind));
    resolved.insert("name", Value::from(invocation_text(invocation, "name")));
    resolved.insert("path", Value::from(invocation_text(invocation, "path")));
    Ok(Value::Object(resolved))
}

fn invocation_text(invocation: Option<&Value>, key: &str) -> String {
    invocation
        .and_then(|invocation| invocation.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// A file: an image by its type, anything else as a path the model can read.
fn file(part: &Value) -> Result<Value, String> {
    let path = text_of(part, "path");
    let image = part
        .get("mimeType")
        .and_then(Value::as_str)
        .is_some_and(|mime| mime.starts_with("image/"));
    if image {
        let mut local = Map::new();
        local.insert("type", Value::from("localImage"));
        local.insert("path", Value::from(path));
        return Ok(Value::Object(local));
    }
    let content = part
        .get("content")
        .filter(|content| content.get("encoding").and_then(Value::as_str) == Some("text"))
        .and_then(|content| content.get("data"))
        .and_then(Value::as_str);
    let text = match content {
        Some(data) => format!("File: {path}\n{data}"),
        None => format!("File: {path}"),
    };
    let mut reference = Map::new();
    reference.insert("type", Value::from("text"));
    reference.insert("text", Value::from(text));
    reference.insert("text_elements", Value::Array(Vec::new().into()));
    Ok(Value::Object(reference))
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        ace_json::parse(text).expect("fixture parses")
    }

    #[test]
    fn text_keeps_its_own_place_and_declares_no_text_elements() {
        let parts = json(r#"[{"type":"text","text":"hello"}]"#);
        assert_eq!(
            native_input(parts.as_array().expect("an array")).expect("mapped"),
            json(r#"[{"type":"text","text":"hello","text_elements":[]}]"#)
        );
    }

    #[test]
    fn a_skill_mention_travels_as_the_invocation_it_resolved_to() {
        let parts = json(
            r#"[{"type":"mention","name":"x","invocation":{"type":"skill","name":"review","path":"/s/review"}}]"#,
        );
        assert_eq!(
            native_input(parts.as_array().expect("an array")).expect("mapped"),
            json(r#"[{"type":"skill","name":"review","path":"/s/review"}]"#)
        );
    }

    #[test]
    fn a_mention_that_resolved_to_nothing_is_refused() {
        let parts = json(r#"[{"type":"mention","invocation":{"type":"slash","name":"x"}}]"#);
        assert_eq!(
            native_input(parts.as_array().expect("an array")),
            Err("Unresolved Codex mention".to_owned())
        );
    }

    #[test]
    fn an_image_part_travels_by_its_url() {
        let parts =
            json(r#"[{"type":"image","url":"data:image/png;base64,AA","mimeType":"image/png"}]"#);
        assert_eq!(
            native_input(parts.as_array().expect("an array")).expect("mapped"),
            json(r#"[{"type":"image","url":"data:image/png;base64,AA"}]"#)
        );
    }

    #[test]
    fn a_file_reference_travels_as_its_path_and_text_content() {
        let text = json(
            r#"[{"type":"file","path":"/w/notes.md","content":{"encoding":"text","data":"hi"}}]"#,
        );
        assert_eq!(
            native_input(text.as_array().expect("an array")).expect("mapped"),
            json(r#"[{"type":"text","text":"File: /w/notes.md\nhi","text_elements":[]}]"#)
        );
        let binary = json(
            r#"[{"type":"file","path":"/w/a.bin","content":{"encoding":"base64","data":"AA"}}]"#,
        );
        assert_eq!(
            native_input(binary.as_array().expect("an array")).expect("mapped"),
            json(r#"[{"type":"text","text":"File: /w/a.bin","text_elements":[]}]"#)
        );
    }

    #[test]
    fn a_file_whose_type_is_an_image_travels_as_a_local_image() {
        let parts = json(r#"[{"type":"file","path":"/w/a.png","mimeType":"image/png"}]"#);
        assert_eq!(
            native_input(parts.as_array().expect("an array")).expect("mapped"),
            json(r#"[{"type":"localImage","path":"/w/a.png"}]"#)
        );
    }
}
