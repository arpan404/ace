// SPDX-License-Identifier: Apache-2.0
//! Content parts and file changes for item drafts.

use serde_json::{Map, Value};

use super::helpers::{list_of, obj_map, str_empty};

pub(crate) fn file_change(entry: &Value) -> Value {
    let c = obj_map(entry);
    let k = c.get("kind").map(obj_map);
    let move_path = k.map(|m| str_empty(m.get("move_path"))).unwrap_or("");
    let kind_type = k.map(|m| str_empty(m.get("type"))).unwrap_or("");
    let kind = if !move_path.is_empty() {
        "move"
    } else if kind_type == "add" {
        "add"
    } else if kind_type == "delete" {
        "delete"
    } else {
        "update"
    };
    let mut map = Map::with_capacity(4);
    map.insert(
        "path".to_owned(),
        Value::String(str_empty(c.get("path")).to_owned()),
    );
    map.insert("kind".to_owned(), Value::String(kind.to_owned()));
    if !move_path.is_empty() {
        map.insert("movePath".to_owned(), Value::String(move_path.to_owned()));
    }
    if let Some(Value::String(diff)) = c.get("diff") {
        map.insert("diff".to_owned(), Value::String(diff.clone()));
    }
    Value::Object(map)
}

pub(crate) fn content(value: Option<&Value>) -> Value {
    let mut out = Vec::new();
    for entry in list_of(value) {
        let p = obj_map(entry);
        let ptype = str_empty(p.get("type"));
        if ptype == "text" {
            let mut part = Map::with_capacity(2);
            part.insert("type".to_owned(), Value::String("text".to_owned()));
            part.insert(
                "text".to_owned(),
                Value::String(str_empty(p.get("text")).to_owned()),
            );
            out.push(Value::Object(part));
        } else if ptype == "image" {
            let mut part = Map::with_capacity(3);
            part.insert("type".to_owned(), Value::String("image".to_owned()));
            part.insert("mimeType".to_owned(), Value::String("image/*".to_owned()));
            part.insert(
                "url".to_owned(),
                Value::String(str_empty(p.get("url")).to_owned()),
            );
            out.push(Value::Object(part));
        } else if ptype == "localImage" || ptype == "mention" || ptype == "skill" {
            let mut part = Map::with_capacity(2);
            part.insert("type".to_owned(), Value::String("file".to_owned()));
            part.insert(
                "path".to_owned(),
                Value::String(str_empty(p.get("path")).to_owned()),
            );
            out.push(Value::Object(part));
        }
    }
    Value::Array(out)
}

pub(crate) fn raw_array(item_type: &str, data: &Value, name: Option<&Value>) -> Value {
    let mut raw = Map::with_capacity(3);
    raw.insert("type".to_owned(), Value::String(item_type.to_owned()));
    if let Some(Value::String(_)) | Some(_) = name
        && let Some(name_value) = name
        && !name_value.is_null()
    {
        // `name` is the native tool name when present; keep it verbatim.
        // TypeScript passes `item["tool"] ?? item["name"]`, which may be
        // non-string; `raw` keeps `name` only when it is a string.
        if let Value::String(s) = name_value {
            raw.insert("name".to_owned(), Value::String(s.clone()));
        }
    }
    raw.insert("data".to_owned(), data.clone());
    Value::Array(vec![Value::Object(raw)])
}

pub(crate) fn raw_for(item_type: &str, data: &Value, name: Option<&Value>) -> Value {
    // `raw(type, data, name)`: keeps `name` only when the caller passed a string.
    // The TypeScript passes `item["tool"] ?? item["name"]`, which is often
    // undefined; here `None` means omitted, `Some(string)` means kept.
    let mut raw = Map::with_capacity(3);
    raw.insert("type".to_owned(), Value::String(item_type.to_owned()));
    if let Some(Value::String(s)) = name {
        raw.insert("name".to_owned(), Value::String(s.clone()));
    }
    raw.insert("data".to_owned(), data.clone());
    Value::Array(vec![Value::Object(raw)])
}
