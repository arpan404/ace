// SPDX-License-Identifier: Apache-2.0
//! Message content: text sources, output summaries, attachments and content parts.

use super::{as_map, is_string, optional_string};
use crate::json_io::{Json, Map, as_count};

pub(super) fn valid_text_source(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["streamId", "bytes", "encoding", "offset"].contains(&key.as_str()))
        && matches!(map.get("streamId"), Some(Json::String(id)) if !id.is_empty())
        && as_count(map.get("bytes")).is_some()
        && matches!(map.get("encoding"), Some(Json::String(encoding)) if encoding == "utf-16le")
        && match map.get("offset") {
            None => true,
            offset => as_count(offset).is_some(),
        }
}

pub(super) fn valid_output_summary(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["streamId", "bytes", "tail", "truncated"].contains(&key.as_str()))
        && matches!(map.get("streamId"), Some(Json::String(id)) if !id.is_empty())
        && as_count(map.get("bytes")).is_some()
        && matches!(map.get("tail"), Some(Json::String(_)))
        && matches!(map.get("truncated"), Some(Json::Bool(_)))
}

pub(crate) fn valid_attachment(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "sha256",
            "bytes",
            "mimeType",
            "name",
            "kind",
            "delivery",
            "width",
            "height",
            "thumbnailAvailable",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(map.get("sha256"), Some(Json::String(hash)) if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return false;
    }
    if as_count(map.get("bytes")).is_none() {
        return false;
    }
    if !matches!(map.get("mimeType"), Some(Json::String(mime)) if mime.len_code_points() <= 128) {
        return false;
    }
    if !matches!(map.get("name"), Some(Json::String(name)) if name.len_code_points() <= 255) {
        return false;
    }
    if let Some(kind) = map.get("kind")
        && !matches!(kind, Json::String(kind) if ["image", "pdf", "text", "binary"].contains(&kind.as_str()))
    {
        return false;
    }
    if let Some(delivery) = map.get("delivery")
        && !matches!(delivery, Json::String(delivery)
                if [
                    "native_image",
                    "native_pdf",
                    "native_resource",
                    "inline_text",
                    "inline_text_and_path",
                    "file_path"
                ]
                .contains(&delivery.as_str()))
    {
        return false;
    }
    for key in ["width", "height"] {
        if let Some(size) = map.get(key)
            && !matches!(as_count(Some(size)), Some(size) if size > 0)
        {
            return false;
        }
    }
    matches!(map.get("thumbnailAvailable"), None | Some(Json::Bool(_)))
}

fn valid_file_content(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    match map.get("encoding").and_then(|encoding| encoding.as_str()) {
        Some("base64") => {
            map.keys()
                .all(|key| ["encoding", "data"].contains(&key.as_str()))
                && matches!(map.get("data"), Some(Json::String(data)) if data.len_code_points() <= 44 * 1024 * 1024)
        }
        Some("text") => {
            map.keys()
                .all(|key| ["encoding", "data"].contains(&key.as_str()))
                && matches!(map.get("data"), Some(Json::String(data)) if data.len_code_points() <= 128 * 1024)
        }
        _ => false,
    }
}

pub(super) fn valid_content_part(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    match map.get("type").and_then(|kind| kind.as_str()) {
        Some("text") => {
            map.keys()
                .all(|key| ["type", "text", "source"].contains(&key.as_str()))
                && is_string(map.get("text"))
                && map.get("source").is_none_or(valid_text_source)
        }
        Some("image") => {
            map.keys()
                .all(|key| ["type", "mimeType", "url"].contains(&key.as_str()))
                && is_string(map.get("mimeType"))
                && is_string(map.get("url"))
        }
        Some("file") => {
            map.keys()
                .all(|key| ["type", "path", "mimeType", "name", "content"].contains(&key.as_str()))
                && is_string(map.get("path"))
                && optional_string(map.get("mimeType"))
                && map.get("name").is_none_or(
                    |name| matches!(name, Json::String(name) if name.len_code_points() <= 255),
                )
                && map.get("content").is_none_or(valid_file_content)
        }
        Some("mention") => valid_mention(map),
        _ => false,
    }
}

fn valid_mention(map: &Map) -> bool {
    if map.keys().any(|key| {
        ![
            "type",
            "entryId",
            "name",
            "title",
            "kind",
            "icon",
            "arguments",
            "values",
            "invocation",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(map.get("entryId"), Some(Json::String(id)) if !id.is_empty() && id.len_code_points() <= 256)
    {
        return false;
    }
    if !matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
    {
        return false;
    }
    if let Some(title) = map.get("title")
        && !matches!(title, Json::String(title) if !title.is_empty() && title.len_code_points() <= 256)
    {
        return false;
    }
    if !matches!(
        map.get("kind"),
        Some(Json::String(kind))
            if [
                "skill",
                "command",
                "plugin",
                "agent",
                "workflow",
                "mcp-tool",
                "builtin"
            ]
            .contains(&kind.as_str())
    ) {
        return false;
    }
    if let Some(icon) = map.get("icon")
        && !matches!(icon, Json::String(icon) if icon.len_code_points() <= 4096)
    {
        return false;
    }
    if !matches!(map.get("arguments"), None | Some(Json::String(_)))
        || matches!(map.get("arguments"), Some(Json::String(args)) if args.len_code_points() > 16384)
    {
        return false;
    }
    if let Some(values) = map.get("values")
        && !valid_prompt_arguments(values)
    {
        return false;
    }
    if let Some(invocation) = map.get("invocation")
        && !valid_catalog_invocation(invocation)
    {
        return false;
    }
    true
}

fn valid_palette_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'_'
                || byte == b'.'
                || byte == b':'
                || byte == b'-'
        })
}

fn valid_prompt_value(value: &Json) -> bool {
    matches!(value, Json::String(text) if text.len_code_points() <= 16384)
        | matches!(value, Json::Number(_))
        | matches!(value, Json::Bool(_))
}

fn valid_prompt_arguments(value: &Json) -> bool {
    match value {
        Json::Object(values) => {
            values.len() <= 64
                && values
                    .iter()
                    .all(|(key, value)| valid_palette_name(key) && valid_prompt_value(value))
        }
        _ => false,
    }
}

fn valid_prompt_argument(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["type", "required", "default"].contains(&key.as_str()))
        && matches!(
            map.get("type"),
            Some(Json::String(kind)) if kind == "string" || kind == "number" || kind == "boolean"
        )
        && map
            .get("required")
            .is_none_or(|required| matches!(required, Json::Bool(_)))
        && map.get("default").is_none_or(valid_prompt_value)
        && matches!(
            (
                map.get("type").and_then(|kind| kind.as_str()),
                map.get("default"),
            ),
            (Some("string"), Some(Json::String(_)))
                | (Some("number"), Some(Json::Number(_)))
                | (Some("boolean"), Some(Json::Bool(_)))
                | (_, None)
        )
}

fn valid_catalog_invocation(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    match map.get("type").and_then(|kind| kind.as_str()) {
        Some("slash") => {
            map.keys()
                .all(|key| ["type", "name"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
        }
        Some("skill" | "mention") => {
            map.keys()
                .all(|key| ["type", "name", "path"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
                && matches!(map.get("path"), Some(Json::String(path)) if !path.is_empty() && path.len_code_points() <= 4096)
        }
        Some("plugin" | "agent") => {
            map.keys()
                .all(|key| ["type", "name"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
        }
        Some("tool") => {
            map.keys()
                .all(|key| ["type", "name", "server"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
                && matches!(map.get("server"), Some(Json::String(server)) if server.len_code_points() <= 256)
        }
        Some("prompt") => {
            map.keys()
                .all(|key| ["type", "commandId", "parameters"].contains(&key.as_str()))
                && matches!(map.get("commandId"), Some(Json::String(id)) if !id.is_empty() && id.len_code_points() <= 256)
                && map.get("parameters").is_none_or(|parameters| {
                    matches!(parameters, Json::Object(parameters)
                    if parameters.len() <= 64
                        && parameters.iter().all(|(key, value)| {
                            valid_palette_name(key) && valid_prompt_argument(value)
                        }))
                })
        }
        Some("action") => {
            map.keys()
                .all(|key| ["type", "action"].contains(&key.as_str()))
                && matches!(map.get("action"), Some(Json::String(action)) if !action.is_empty() && action.len_code_points() <= 128)
        }
        Some("unavailable") => {
            map.keys()
                .all(|key| ["type", "reason"].contains(&key.as_str()))
                && matches!(map.get("reason"), Some(Json::String(reason)) if !reason.is_empty() && reason.len_code_points() <= 2048)
        }
        _ => false,
    }
}
