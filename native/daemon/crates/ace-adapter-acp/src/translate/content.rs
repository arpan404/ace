// SPDX-License-Identifier: Apache-2.0
//! Native content as parts ace can show (`content.ts`).

use crate::translate::data::{object, string};
use ace_json::{Map, Value};

const TEXT_BOUND: usize = 128 * 1024;
const BLOB_BOUND: usize = 44 * 1024 * 1024;

/// Native content as parts ace can show.
pub fn decode_content(value: &Value) -> Vec<Value> {
    let content = object(value);
    let uri = string(content.get("uri").unwrap_or(&Value::Null));
    let kind = string(content.get("type").unwrap_or(&Value::Null));
    match kind {
        "text" => match content.get("text") {
            Some(Value::String(text)) => vec![text_part(text)],
            _ => Vec::new(),
        },
        "image" => {
            let data = string(content.get("data").unwrap_or(&Value::Null));
            let mime_type = string(content.get("mimeType").unwrap_or(&Value::Null));
            let mime = if mime_type.is_empty() {
                sniff_image(data)
            } else {
                mime_type.to_owned()
            };
            if !data.is_empty() {
                vec![image_part(&mime, data)]
            } else {
                reference(uri, "", &mime, None)
            }
        }
        "resource_link" => reference(
            uri,
            string(content.get("name").unwrap_or(&Value::Null)),
            string(content.get("mimeType").unwrap_or(&Value::Null)),
            None,
        ),
        "resource" => {
            let resource = object(content.get("resource").unwrap_or(&Value::Null));
            reference(
                string(resource.get("uri").unwrap_or(&Value::Null)),
                "",
                string(resource.get("mimeType").unwrap_or(&Value::Null)),
                embedded(resource),
            )
        }
        "audio" => {
            let mime = string(content.get("mimeType").unwrap_or(&Value::Null));
            let suffix = if mime.is_empty() {
                String::new()
            } else {
                format!(" {mime}")
            };
            vec![text_part(&format!("[audio{suffix}]"))]
        }
        _ => Vec::new(),
    }
}

fn text_part(text: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("text".to_owned()));
    map.insert("text".to_owned(), Value::from(text.to_owned()));
    Value::Object(map)
}

fn image_part(mime_type: &str, data: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("image".to_owned()));
    map.insert("mimeType".to_owned(), Value::from(mime_type.to_owned()));
    map.insert(
        "url".to_owned(),
        Value::from(format!("data:{mime_type};base64,{data}")),
    );
    Value::Object(map)
}

fn reference(uri: &str, name: &str, mime_type: &str, content: Option<Value>) -> Vec<Value> {
    if let Some(path) = file_path(uri) {
        let mut map = Map::with_capacity(5);
        map.insert("type".to_owned(), Value::from("file".to_owned()));
        map.insert("path".to_owned(), Value::from(path));
        if !mime_type.is_empty() {
            map.insert("mimeType".to_owned(), Value::from(mime_type.to_owned()));
        }
        if !name.is_empty() {
            let truncated: String = name.chars().take(255).collect();
            map.insert("name".to_owned(), Value::from(truncated));
        }
        if let Some(content) = content {
            map.insert("content".to_owned(), content);
        }
        return vec![Value::Object(map)];
    }
    if uri.is_empty() {
        Vec::new()
    } else {
        vec![text_part(uri)]
    }
}

fn embedded(resource: &Map) -> Option<Value> {
    if let Some(Value::String(text)) = resource.get("text") {
        if text.len() <= TEXT_BOUND {
            let mut map = Map::with_capacity(2);
            map.insert("encoding".to_owned(), Value::from("text".to_owned()));
            map.insert("data".to_owned(), Value::String(text.clone()));
            return Some(Value::Object(map));
        }
        return None;
    }
    if let Some(Value::String(blob)) = resource.get("blob")
        && blob.len() <= BLOB_BOUND
    {
        let mut map = Map::with_capacity(2);
        map.insert("encoding".to_owned(), Value::from("base64".to_owned()));
        map.insert("data".to_owned(), Value::String(blob.clone()));
        return Some(Value::Object(map));
    }
    None
}

fn sniff_image(base64: &str) -> String {
    if base64.starts_with("/9j/") {
        "image/jpeg".to_owned()
    } else if base64.starts_with("R0lGOD") {
        "image/gif".to_owned()
    } else if base64.starts_with("UklGR") {
        "image/webp".to_owned()
    } else {
        "image/png".to_owned()
    }
}

/// A `file:` URI to a local path, percent-decoded, or None.
fn file_path(uri: &str) -> Option<String> {
    if !uri.starts_with("file:") {
        return None;
    }
    let after = uri.strip_prefix("file:").unwrap_or("");
    let path_part = if let Some(rest) = after.strip_prefix("//") {
        let slash = rest.find('/')?;
        let (host, path) = rest.split_at(slash);
        if host.is_empty() || host == "localhost" {
            path.to_owned()
        } else {
            return None;
        }
    } else {
        after.to_owned()
    };
    percent_decode(&path_part)
}

fn percent_decode(input: &str) -> Option<String> {
    let mut bytes: Vec<u8> = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut index = 0usize;
    while index < raw.len() {
        if raw[index] == b'%' {
            if index + 2 >= raw.len() {
                return None;
            }
            let hex = input.get(index + 1..index + 3)?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            bytes.push(byte);
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}
