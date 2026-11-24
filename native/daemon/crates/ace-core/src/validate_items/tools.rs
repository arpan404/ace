// SPDX-License-Identifier: Apache-2.0
//! Tool calls: the call envelope, its per-kind details, file changes and results.

use super::content::{valid_attachment, valid_output_summary};
use super::{as_map, is_string, optional_string};
use crate::json_io::{Json, Map, as_count, as_integer};
use crate::validate_shapes::valid_todo_entry;

fn valid_file_change(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["path", "kind", "movePath", "diff", "oldText", "newText"].contains(&key.as_str())
    }) && is_string(map.get("path"))
        && matches!(
            map.get("kind"),
            Some(Json::String(kind)) if ["add", "update", "delete", "move"].contains(&kind.as_str())
        )
        && optional_string(map.get("movePath"))
        && optional_string(map.get("diff"))
        && map
            .get("oldText")
            .is_none_or(|old| matches!(old, Json::Null) | matches!(old, Json::String(_)))
        && optional_string(map.get("newText"))
}

fn valid_tool_detail(detail: &Map) -> bool {
    let kind = detail.get("kind").and_then(|kind| kind.as_str());
    match kind {
        Some("shell") => {
            detail.keys().all(|key| {
                [
                    "kind",
                    "command",
                    "rawCommand",
                    "description",
                    "cwd",
                    "exitCode",
                    "output",
                ]
                .contains(&key.as_str())
            }) && is_string(detail.get("command"))
                && optional_string(detail.get("rawCommand"))
                && optional_string(detail.get("description"))
                && optional_string(detail.get("cwd"))
                && detail.get("exitCode").is_none_or(|code| {
                    matches!(code, Json::Null) || as_integer(Some(code)).is_some()
                })
                && detail.get("output").is_none_or(valid_output_summary)
        }
        Some("file.read") => {
            detail
                .keys()
                .all(|key| ["kind", "path", "range"].contains(&key.as_str()))
                && is_string(detail.get("path"))
                && detail.get("range").is_none_or(|range| {
                    matches!(as_map(range), Some(range)
                            if range.keys().all(|key| ["start", "end"].contains(&key.as_str()))
                                && as_integer(range.get("start")).is_some()
                                && as_integer(range.get("end")).is_some())
                })
        }
        Some("file.edit" | "file.write" | "file.delete" | "file.move") => {
            detail
                .keys()
                .all(|key| ["kind", "changes"].contains(&key.as_str()))
                && detail
                    .get("changes")
                    .and_then(|changes| changes.as_array())
                    .is_some_and(|changes| changes.iter().all(valid_file_change))
        }
        Some("search") => {
            detail
                .keys()
                .all(|key| ["kind", "query", "path", "matches", "scope"].contains(&key.as_str()))
                && is_string(detail.get("query"))
                && optional_string(detail.get("path"))
                && detail
                    .get("matches")
                    .is_none_or(|matches| as_integer(Some(matches)).is_some())
                && detail
                    .get("scope")
                    .is_none_or(|scope| matches!(scope, Json::String(scope) if scope == "tools"))
        }
        Some("web.search") => {
            detail
                .keys()
                .all(|key| ["kind", "query"].contains(&key.as_str()))
                && is_string(detail.get("query"))
        }
        Some("web.fetch") => {
            detail
                .keys()
                .all(|key| ["kind", "url"].contains(&key.as_str()))
                && is_string(detail.get("url"))
        }
        Some("mcp") => {
            detail
                .keys()
                .all(|key| ["kind", "server", "tool", "arguments"].contains(&key.as_str()))
                && is_string(detail.get("server"))
                && is_string(detail.get("tool"))
        }
        Some("agent.spawn") => {
            detail.keys().all(|key| {
                ["kind", "description", "prompt", "agentType", "childAgentId"]
                    .contains(&key.as_str())
            }) && optional_string(detail.get("description"))
                && optional_string(detail.get("prompt"))
                && optional_string(detail.get("agentType"))
                && optional_string(detail.get("childAgentId"))
        }
        Some("agent.message") => {
            detail
                .keys()
                .all(|key| ["kind", "targetAgentId", "message"].contains(&key.as_str()))
                && optional_string(detail.get("targetAgentId"))
                && optional_string(detail.get("message"))
        }
        Some("todo") => {
            detail
                .keys()
                .all(|key| ["kind", "todos"].contains(&key.as_str()))
                && detail
                    .get("todos")
                    .and_then(|todos| todos.as_array())
                    .is_some_and(|todos| todos.iter().all(valid_todo_entry))
        }
        Some("plan") => detail
            .keys()
            .all(|key| ["kind", "markdown", "todos"].contains(&key.as_str()))
            && optional_string(detail.get("markdown"))
            && detail.get("todos").is_none_or(
                |todos| matches!(todos, Json::Array(todos) if todos.iter().all(valid_todo_entry)),
            ),
        Some("ask_user") => detail.keys().all(|key| key == "kind"),
        Some("image") => {
            detail.keys().all(|key| {
                ["kind", "path", "sourcePath", "attachment", "unavailable"].contains(&key.as_str())
            }) && detail
                .get("path")
                .is_none_or(|path| matches!(path, Json::String(path) if path.len() <= 4096))
                && detail
                    .get("sourcePath")
                    .is_none_or(|path| matches!(path, Json::String(path) if path.len() <= 4096))
                && detail.get("attachment").is_none_or(valid_attachment)
                && optional_string(detail.get("unavailable"))
        }
        Some("browser" | "notebook" | "custom") => detail.keys().all(|key| key == "kind"),
        _ => false,
    }
}

fn valid_tool_result(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "isError",
            "content",
            "structuredContent",
            "durationMs",
            "target",
            "mode",
            "scale",
            "size",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(map.get("isError"), Some(Json::Bool(_))) {
        return false;
    }
    let content_valid = match map.get("content") {
        Some(Json::Array(content)) => {
            content.len() <= 16
                && content.iter().all(|entry| {
                    let Some(entry) = as_map(entry) else {
                        return false;
                    };
                    match entry.get("type").and_then(|kind| kind.as_str()) {
                        Some("text") => {
                            entry.keys().all(|key| ["type", "text"].contains(&key.as_str()))
                                && matches!(entry.get("text"), Some(Json::String(text)) if text.len() <= 32_768)
                        }
                        Some("image") => {
                            entry.keys().all(|key| ["type", "attachment"].contains(&key.as_str()))
                                && valid_attachment_inner(entry.get("attachment"))
                        }
                        _ => false,
                    }
                })
        }
        _ => false,
    };
    if !content_valid {
        return false;
    }
    if !map.get("durationMs").is_none_or(|duration| {
        matches!(duration, Json::Number(duration) if duration.as_f64().is_some_and(|duration| duration.is_finite() && duration >= 0.0))
    }) {
        return false;
    }
    if let Some(target) = map.get("target") {
        if matches!(target, Json::Null) {
            return false;
        }
        let Some(target) = as_map(target) else {
            return false;
        };
        if target
            .keys()
            .any(|key| !["bundleId", "windowId", "displayName"].contains(&key.as_str()))
        {
            return false;
        }
        if !matches!(target.get("bundleId"), Some(Json::String(id)) if id.len() <= 256) {
            return false;
        }
        if let Some(window) = target.get("windowId")
            && (matches!(window, Json::Null)
                || !matches!(as_integer(Some(window)), Some(window) if window >= 0))
        {
            return false;
        }
        if let Some(name) = target.get("displayName")
            && (matches!(name, Json::Null)
                || !matches!(name, Json::String(name) if name.len() <= 256))
        {
            return false;
        }
    }
    if let Some(mode) = map.get("mode")
        && (matches!(mode, Json::Null)
            || !matches!(mode, Json::String(mode) if mode == "background" || mode == "foreground"))
    {
        return false;
    }
    if let Some(scale) = map.get("scale")
        && (matches!(scale, Json::Null)
            || !matches!(scale, Json::Number(scale) if scale.as_f64().is_some_and(|scale| scale.is_finite() && scale > 0.0)))
    {
        return false;
    }
    if let Some(size) = map.get("size") {
        if matches!(size, Json::Null) {
            return false;
        }
        let Some(size) = as_map(size) else {
            return false;
        };
        if size
            .keys()
            .any(|key| !["width", "height"].contains(&key.as_str()))
        {
            return false;
        }
        for key in ["width", "height"] {
            if !matches!(as_integer(size.get(key)), Some(dimension) if dimension > 0 && dimension <= 16_384)
            {
                return false;
            }
        }
    }
    true
}

fn valid_attachment_inner(value: Option<&Json>) -> bool {
    match value {
        Some(value) => valid_attachment(value),
        None => false,
    }
}

pub(super) fn valid_tool_call(call: &Map) -> bool {
    if call.keys().any(|key| {
        ![
            "id",
            "agentId",
            "kind",
            "title",
            "status",
            "detail",
            "backgroundTaskId",
            "error",
            "result",
            "startedAt",
            "endedAt",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !is_string(call.get("id")) || !is_string(call.get("agentId")) {
        return false;
    }
    if !matches!(
        call.get("kind"),
        Some(Json::String(kind))
            if [
                "shell",
                "file.read",
                "file.edit",
                "file.write",
                "file.delete",
                "file.move",
                "search",
                "web.search",
                "web.fetch",
                "mcp",
                "agent.spawn",
                "agent.message",
                "todo",
                "plan",
                "ask_user",
                "browser",
                "image",
                "notebook",
                "custom"
            ]
            .contains(&kind.as_str())
    ) {
        return false;
    }
    if !is_string(call.get("title")) {
        return false;
    }
    if !matches!(
        call.get("status"),
        Some(Json::String(status))
            if [
                "pending",
                "awaiting_approval",
                "running",
                "succeeded",
                "failed",
                "declined",
                "cancelled"
            ]
            .contains(&status.as_str())
    ) {
        return false;
    }
    if !call
        .get("detail")
        .and_then(as_map)
        .is_some_and(valid_tool_detail)
    {
        return false;
    }
    if !optional_string(call.get("backgroundTaskId")) {
        return false;
    }
    if !optional_string(call.get("error")) {
        return false;
    }
    if let Some(result) = call.get("result")
        && (matches!(result, Json::Null) || !valid_tool_result(result))
    {
        return false;
    }
    if as_count(call.get("startedAt")).is_none() {
        return false;
    }
    if let Some(ended) = call.get("endedAt")
        && (matches!(ended, Json::Null) || as_count(Some(ended)).is_none())
    {
        return false;
    }
    if !call
        .get("raw")
        .and_then(|raw| raw.as_array())
        .is_some_and(|raw| raw.iter().all(crate::validate_shapes::valid_raw_payload))
    {
        return false;
    }
    true
}
