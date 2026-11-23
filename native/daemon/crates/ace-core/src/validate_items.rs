// SPDX-License-Identifier: Apache-2.0
//! The item preflight of `validate.ts` (`itemError`): identity fields belong
//! to core, owners must match, tool references use native keys, legacy
//! output must extend the stream, and the merged candidate must form a
//! canonical item with no unknown fields.

use crate::emit::get;
use crate::item_input::{detail_candidate, item_detail_kind, merge_candidate};
use crate::items::Item;
use crate::json_io::{Json, Map, as_count, as_integer};
use crate::output_snapshot::extends_output;
use crate::state::{AgentRecord, ThreadState};
use crate::validate::relation_error;
use crate::validate_shapes::{
    valid_agent_machine, valid_provider_kind, valid_timestamp, valid_todo_entry,
};

pub const SCREEN_KEYS: &[&str] = &[
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Enter",
    "Return",
    "Tab",
    "Space",
    "Backspace",
    "Escape",
    "Esc",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Left",
    "Right",
    "Up",
    "Down",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "enter",
    "return",
    "tab",
    "space",
    "backspace",
    "escape",
    "esc",
    "delete",
    "home",
    "end",
    "pageup",
    "pagedown",
    "left",
    "right",
    "up",
    "down",
    "arrowleft",
    "arrowright",
    "arrowup",
    "arrowdown",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
    "F13",
    "F14",
    "F15",
    "F16",
    "F17",
    "F18",
    "F19",
    "F20",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "f13",
    "f14",
    "f15",
    "f16",
    "f17",
    "f18",
    "f19",
    "f20",
    "-",
    "=",
    "[",
    "]",
    "\\",
    ";",
    "'",
    ",",
    ".",
    "/",
    "`",
    "!",
    "@",
    "#",
    "$",
    "%",
    "^",
    "&",
    "*",
    "(",
    ")",
    "_",
    "+",
    "{",
    "}",
    "|",
    ":",
    "',
  ",
    ",
  ",
    ",
  ",
    ",
  ",
];

/// Whether a key names a real screen key.
pub(crate) fn screen_key_valid(key: &str) -> bool {
    SCREEN_KEYS.contains(&key)
}

/// Whether the merged candidate validates.
pub enum ItemCheck {
    /// The candidate forms a canonical item.
    Ok,
    /// A field has the wrong shape.
    Invalid,
    /// Unknown fields would be stripped.
    UnknownFields,
}

fn as_map(value: &Json) -> Option<&Map> {
    match value {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn get_str<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|value| value.as_str())
}

fn is_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(_)))
}

fn optional_string(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::String(_)))
}

fn valid_id(value: Option<&Json>, min: usize, max: usize) -> bool {
    matches!(value, Some(Json::String(id)) if id.len() >= min && id.len() <= max)
}

fn valid_optional_timestamp(value: Option<&Json>) -> bool {
    match value {
        None => true,
        Some(_) => valid_timestamp(value),
    }
}

/// The item error for one upsert or reconciled fact, if any.
pub fn item_error(state: &ThreadState, fact: &Map, fact_type: &str, now: i64) -> Option<String> {
    let draft = match fact.get("draft") {
        Some(Json::Object(draft)) => draft,
        _ => return Some("item draft must be an object".to_owned()),
    };
    if ["id", "agentId", "runId", "createdAt"]
        .iter()
        .any(|field| draft.contains_key(*field))
    {
        return Some("item identity and creation time belong to core".to_owned());
    }
    let agent_key = get_str(fact, "agent").unwrap_or("");
    let item_key = get_str(fact, "item").unwrap_or("");
    let previous = get(&state.items, item_key);
    let owner = get(&state.agents, agent_key);
    if let Some(previous) = previous
        && Some(previous.agent_id()) != owner.map(|record| record.agent.id.as_str())
    {
        return Some("item key has a different owner".to_owned());
    }
    let draft_type = draft.get("type").and_then(|kind| kind.as_str());
    let draft_call = draft.get("call").and_then(as_map);
    if draft_type == Some("tool_call") {
        if draft
            .get("call")
            .is_some_and(|call| !matches!(call, Json::Object(_)))
        {
            return Some("tool draft must be an object".to_owned());
        }
        if let Some(call) = draft_call
            && ["id", "agentId", "backgroundTaskId"]
                .iter()
                .any(|field| call.contains_key(*field))
        {
            return Some("tool identities belong to core".to_owned());
        }
    }
    let detail = draft_call.and_then(|call| call.get("detail"));
    if detail.is_some() && !matches!(detail, Some(Json::Object(_))) {
        return Some("tool detail must be an object".to_owned());
    }
    if let Some(Json::Object(detail)) = detail {
        if ["childAgentId", "targetAgentId"]
            .iter()
            .any(|field| detail.contains_key(*field))
        {
            return Some("tool agent references must use native keys".to_owned());
        }
        if detail.contains_key("output") && !optional_string(detail.get("output")) {
            return Some(
                "output summaries belong to core; adapters append output deltas".to_owned(),
            );
        }
        if detail.get("kind").and_then(|kind| kind.as_str()) == Some("agent.spawn")
            && detail.contains_key("childAgent")
        {
            match detail.get("childAgent") {
                Some(Json::String(child)) => {
                    if let Some(error) = relation_error(state, child, agent_key) {
                        return Some(error);
                    }
                }
                _ => return Some("child agent key must be a string".to_owned()),
            }
        }
        if detail.get("kind").and_then(|kind| kind.as_str()) == Some("agent.message")
            && !optional_string(detail.get("targetAgent"))
        {
            return Some("target agent key must be a string".to_owned());
        }
        if item_detail_kind(previous, draft).as_deref() == Some("shell")
            && detail.contains_key("output")
            && matches!(detail.get("output"), Some(Json::String(_)))
            && matches!(
                previous,
                Some(Item::ToolCall { call, .. })
                    if matches!(
                        &call.detail,
                        crate::item_model::ToolDetail::Shell { .. }
                    )
            )
        {
            let aggregate = detail
                .get("output")
                .and_then(|output| output.as_str())
                .unwrap_or("");
            let prior = match previous {
                Some(Item::ToolCall { call, .. }) => match &call.detail {
                    crate::item_model::ToolDetail::Shell { output, .. } => output.clone(),
                    _ => None,
                },
                _ => None,
            };
            if fact_type != "item.reconciled" && !extends_output(prior.as_ref(), aggregate) {
                return Some("legacy output must extend the existing stream".to_owned());
            }
        }
    }
    let base_owner: Option<&AgentRecord> = owner;
    let candidate = merge_candidate(
        previous,
        &crate::item_input::ItemIdentity {
            id: previous
                .map(|item| item.id().to_owned())
                .unwrap_or_else(|| "validation_item".to_owned()),
            agent_id: base_owner
                .map(|record| record.agent.id.clone())
                .unwrap_or_else(|| "validation_agent".to_owned()),
            created_at: previous.map(crate::items::item_created_at).unwrap_or(now),
            run_id: None,
        },
        draft,
        now,
        detail.and_then(as_map).map(detail_candidate).as_ref(),
    );
    match validate_merged_item(&candidate) {
        ItemCheck::Ok => {}
        ItemCheck::Invalid => {
            return Some("item draft does not form a valid canonical item".to_owned());
        }
        ItemCheck::UnknownFields => {
            return Some("unknown item fields must be retained as raw data".to_owned());
        }
    }
    let call = candidate.get("call").and_then(as_map);
    let (kind, detail_kind) = match (
        call.and_then(|call| get_str(call, "kind")),
        call.and_then(|call| call.get("detail"))
            .and_then(as_map)
            .and_then(|detail| get_str(detail, "kind")),
    ) {
        (Some(kind), Some(detail_kind)) => (kind, detail_kind),
        _ => ("", ""),
    };
    if candidate.get("type").and_then(|kind| kind.as_str()) == Some("tool_call")
        && !kind.is_empty()
        && kind != detail_kind
    {
        return Some("tool kind contradicts its detail".to_owned());
    }
    if candidate.get("type").and_then(|kind| kind.as_str()) == Some("tool_call")
        && detail_kind == "agent.spawn"
    {
        let mut children: Vec<String> = get(&state.indexes.pending_spawn_links, item_key)
            .map(|agents| {
                agents
                    .keys()
                    .filter(|child| {
                        get(&state.agents, child).is_some_and(|record| {
                            record.spawned_by_key.as_deref() == Some(item_key)
                        })
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if let Some(linked) =
            get(&state.item_links, item_key).and_then(|links| links.child_agent.clone())
            && !children.contains(&linked)
        {
            children.push(linked);
        }
        for child in children {
            if let Some(error) = relation_error(state, &child, agent_key) {
                return Some(error);
            }
        }
    }
    None
}
fn valid_base(candidate: &Map) -> bool {
    is_string(candidate.get("id"))
        && is_string(candidate.get("agentId"))
        && candidate
            .get("runId")
            .is_none_or(|run| is_string(Some(run)))
        && valid_timestamp(candidate.get("createdAt"))
        && candidate
            .get("nativeId")
            .is_none_or(|id| matches!(id, Json::String(id) if id.len() <= 256))
        && candidate
            .get("executionSource")
            .is_none_or(valid_execution_source)
        && candidate
            .get("complete")
            .is_none_or(|complete| matches!(complete, Json::Bool(_)))
        && candidate.get("inherited").is_none_or(valid_inherited)
        && candidate
            .get("rawOmitted")
            .is_none_or(|raw| matches!(raw, Json::Bool(true)))
}

fn valid_execution_source(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map
        .keys()
        .any(|key| !["nativeSessionId", "selection"].contains(&key.as_str()))
    {
        return false;
    }
    if !is_string(map.get("nativeSessionId")) {
        return false;
    }
    let Some(selection) = map.get("selection").and_then(as_map) else {
        return false;
    };
    if selection
        .keys()
        .any(|key| !["provider", "model", "instanceId", "options"].contains(&key.as_str()))
    {
        return false;
    }
    if !valid_provider_kind(selection.get("provider")) {
        return false;
    }
    if let Some(model) = selection.get("model")
        && (matches!(model, Json::Null)
            || !matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256))
    {
        return false;
    }
    if let Some(instance) = selection.get("instanceId")
        && (matches!(instance, Json::Null)
            || !matches!(instance, Json::String(instance) if !instance.is_empty() && instance.len() <= 256))
    {
        return false;
    }
    match selection.get("options") {
        None => true,
        Some(Json::Object(options)) => options.keys().all(|key| key.len() <= 128),
        _ => false,
    }
}

fn valid_inherited(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["threadId", "itemId", "at"].contains(&key.as_str()))
        && is_string(map.get("threadId"))
        && optional_string(map.get("itemId"))
        && match map.get("at") {
            None => true,
            at => as_count(at).is_some(),
        }
}

fn valid_text_source(value: &Json) -> bool {
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

fn valid_output_summary(value: &Json) -> bool {
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
    if !matches!(map.get("mimeType"), Some(Json::String(mime)) if mime.len() <= 128) {
        return false;
    }
    if !matches!(map.get("name"), Some(Json::String(name)) if name.len() <= 255) {
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
                && matches!(map.get("data"), Some(Json::String(data)) if data.len() <= 44 * 1024 * 1024)
        }
        Some("text") => {
            map.keys()
                .all(|key| ["encoding", "data"].contains(&key.as_str()))
                && matches!(map.get("data"), Some(Json::String(data)) if data.len() <= 128 * 1024)
        }
        _ => false,
    }
}

fn valid_content_part(value: &Json) -> bool {
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
                && map
                    .get("name")
                    .is_none_or(|name| matches!(name, Json::String(name) if name.len() <= 255))
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
    if !matches!(map.get("entryId"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 256) {
        return false;
    }
    if !matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
    {
        return false;
    }
    if let Some(title) = map.get("title")
        && !matches!(title, Json::String(title) if !title.is_empty() && title.len() <= 256)
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
        && !matches!(icon, Json::String(icon) if icon.len() <= 4096)
    {
        return false;
    }
    if !matches!(map.get("arguments"), None | Some(Json::String(_)))
        || matches!(map.get("arguments"), Some(Json::String(args)) if args.len() > 16384)
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
    matches!(value, Json::String(text) if text.len() <= 16384)
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
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        }
        Some("skill" | "mention") => {
            map.keys()
                .all(|key| ["type", "name", "path"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
                && matches!(map.get("path"), Some(Json::String(path)) if !path.is_empty() && path.len() <= 4096)
        }
        Some("plugin" | "agent") => {
            map.keys()
                .all(|key| ["type", "name"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        }
        Some("tool") => {
            map.keys()
                .all(|key| ["type", "name", "server"].contains(&key.as_str()))
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
                && matches!(map.get("server"), Some(Json::String(server)) if server.len() <= 256)
        }
        Some("prompt") => {
            map.keys()
                .all(|key| ["type", "commandId", "parameters"].contains(&key.as_str()))
                && matches!(map.get("commandId"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 256)
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
                && matches!(map.get("action"), Some(Json::String(action)) if !action.is_empty() && action.len() <= 128)
        }
        Some("unavailable") => {
            map.keys()
                .all(|key| ["type", "reason"].contains(&key.as_str()))
                && matches!(map.get("reason"), Some(Json::String(reason)) if !reason.is_empty() && reason.len() <= 2048)
        }
        _ => false,
    }
}

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
                ["kind", "command", "rawCommand", "cwd", "exitCode", "output"]
                    .contains(&key.as_str())
            }) && is_string(detail.get("command"))
                && optional_string(detail.get("rawCommand"))
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

fn valid_tool_call(call: &Map) -> bool {
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

fn valid_message_origin(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "kind",
            "client",
            "commandId",
            "interactionId",
            "threadIds",
            "role",
            "from",
            "to",
            "sources",
            "lossy",
            "freshSession",
            "afterExit",
            "via",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        map.get("kind"),
        Some(Json::String(kind))
            if [
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
                "background_completion"
            ]
            .contains(&kind.as_str())
    ) {
        return false;
    }
    if let Some(client) = map.get("client") {
        if matches!(client, Json::Null) {
            return false;
        }
        let Some(client) = as_map(client) else {
            return false;
        };
        if client
            .keys()
            .any(|key| !["grantId", "name"].contains(&key.as_str()))
        {
            return false;
        }
        if !matches!(client.get("grantId"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
        {
            return false;
        }
        if !matches!(client.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        {
            return false;
        }
    }
    for key in ["commandId", "interactionId"] {
        if let Some(id) = map.get(key)
            && (matches!(id, Json::Null) || !is_string(Some(id)))
        {
            return false;
        }
    }
    if let Some(threads) = map.get("threadIds")
        && (matches!(threads, Json::Null)
            || !matches!(threads, Json::Array(threads) if threads.iter().all(|id| is_string(Some(id)))))
    {
        return false;
    }
    if !optional_string(map.get("role")) {
        return false;
    }
    for key in ["from", "to"] {
        if let Some(endpoint) = map.get(key) {
            let Some(endpoint) = as_map(endpoint) else {
                return false;
            };
            if endpoint
                .keys()
                .any(|key| !["provider", "model"].contains(&key.as_str()))
            {
                return false;
            }
            if !valid_provider_kind(endpoint.get("provider")) {
                return false;
            }
            if let Some(model) = endpoint.get("model")
                && !matches!(model, Json::String(model) if !model.is_empty())
            {
                return false;
            }
        }
    }
    if let Some(sources) = map.get("sources") {
        if matches!(sources, Json::Null) {
            return false;
        }
        let valid = match sources {
            Json::Array(sources) => {
                sources.len() <= 8
                    && sources.iter().all(|source| {
                        let Some(source) = as_map(source) else {
                            return false;
                        };
                        source.keys().all(|key| ["provider", "model"].contains(&key.as_str()))
                            && valid_provider_kind(source.get("provider"))
                            && source.get("model").is_none_or(|model| {
                                matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256)
                            })
                    })
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    for key in ["lossy", "freshSession", "afterExit"] {
        if !matches!(map.get(key), None | Some(Json::Bool(_))) {
            return false;
        }
    }
    if let Some(via) = map.get("via") {
        if matches!(via, Json::Null) {
            return false;
        }
        let Some(via) = as_map(via) else {
            return false;
        };
        if via
            .keys()
            .any(|key| !["threadId", "title"].contains(&key.as_str()))
        {
            return false;
        }
        if !is_string(via.get("threadId")) {
            return false;
        }
        if let Some(title) = via.get("title")
            && !matches!(title, Json::String(title) if title.len() <= 256)
        {
            return false;
        }
    }
    true
}

fn valid_spade_face(value: &Json) -> bool {
    match value {
        Json::Object(face) => {
            face.len() <= 24
                && face.keys().all(|key| key.len() <= 32)
                && face.values().all(|value| {
                    matches!(value, Json::String(text) if text.len() <= 256)
                        | matches!(value, Json::Number(_))
                        | matches!(value, Json::Bool(_))
                        | matches!(value, Json::Null)
                })
        }
        _ => false,
    }
}

fn valid_addressee(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("bot") => {
            map.keys().all(|key| ["kind", "id", "name", "avatar", "machine"].contains(&key.as_str()))
                && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120)
                && map.get("avatar").is_none_or(valid_spade_face)
                && map.get("machine").is_none_or(|machine| {
                    matches!(as_map(machine), Some(machine)
                            if machine.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                                && is_string(machine.get("id"))
                                && is_string(machine.get("name")))
                })
        }
        Some("club") => {
            map.keys().all(|key| ["kind", "id", "name", "faces", "machine"].contains(&key.as_str()))
                && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120)
                && map.get("faces").is_none_or(|faces| {
                    matches!(faces, Json::Array(faces) if faces.len() <= 3 && faces.iter().all(|face| {
                            let Some(face) = as_map(face) else {
                                return false;
                            };
                            face.keys().all(|key| ["id", "avatar"].contains(&key.as_str()))
                                && matches!(face.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                                && face.get("avatar").is_none_or(valid_spade_face)
                        }))
                })
                && map.get("machine").is_none_or(|machine| {
                    matches!(as_map(machine), Some(machine)
                            if machine.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                                && is_string(machine.get("id"))
                                && is_string(machine.get("name")))
                })
        }
        Some("agent") => {
            map.keys().all(|key| ["kind", "threadId", "title", "provider"].contains(&key.as_str()))
                && is_string(map.get("threadId"))
                && matches!(map.get("title"), Some(Json::String(title)) if title.len() <= 256)
                && map.get("provider").is_none_or(|provider| {
                    valid_provider_kind(Some(provider))
                })
        }
        _ => false,
    }
}

fn valid_asked_line(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["about", "to", "devices", "share", "shares", "words"].contains(&key.as_str())
    }) && is_string(map.get("about"))
        && map
            .get("to")
            .and_then(|to| to.as_array())
            .is_some_and(|to| {
                to.iter().all(|entry| {
                    let Some(entry) = as_map(entry) else {
                        return false;
                    };
                    entry.keys().all(|key| ["to", "state", "detail"].contains(&key.as_str()))
                        && valid_addressee(entry.get("to").unwrap_or(&Json::Null))
                        && matches!(
                            entry.get("state"),
                            Some(Json::String(state))
                                if [
                                    "sending", "queued", "answering", "waiting", "answered", "stopped",
                                    "failed", "sent"
                                ]
                                .contains(&state.as_str())
                        )
                        && entry.get("detail").is_none_or(|detail| {
                            matches!(detail, Json::Null)
                                | matches!(detail, Json::String(detail) if detail.len() <= 512)
                        })
                })
            })
        && map
            .get("devices")
            .and_then(|devices| devices.as_array())
            .is_some_and(|devices| devices.iter().all(valid_device_context_item))
        && matches!(
            map.get("share"),
            Some(Json::String(share)) if share == "thread" || share == "message"
        )
        && map
            .get("shares")
            .and_then(|shares| shares.as_array())
            .is_some_and(|shares| {
                shares
                    .iter()
                    .all(|share| matches!(share, Json::String(_)))
            })
        && optional_string(map.get("words"))
}

fn valid_device_context_item(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    // `strictObject`: exactly these keys.
    map.keys().all(|key| {
        ["type", "id", "name", "kind", "machine", "os", "model", "online"].contains(&key.as_str())
    }) && matches!(map.get("type"), Some(Json::String(kind)) if kind == "device")
        && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 256)
        && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        && matches!(
            map.get("kind"),
            Some(Json::String(kind))
                if [
                    "laptop", "desktop", "server", "phone", "tablet", "browser", "simulator",
                    "emulator"
                ]
                .contains(&kind.as_str())
        )
        && map.get("machine").and_then(as_map).is_some_and(|machine| {
            machine.keys().all(|key| ["id", "name", "here"].contains(&key.as_str()))
                && matches!(machine.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 256)
                && matches!(machine.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
                && matches!(machine.get("here"), Some(Json::Bool(_)))
        })
        && map.get("os").is_none_or(|os| {
            matches!(os, Json::Null) | matches!(os, Json::String(os) if os.len() <= 64)
        })
        && map.get("model").is_none_or(|model| {
            matches!(model, Json::Null) | matches!(model, Json::String(model) if model.len() <= 256)
        })
        && matches!(map.get("online"), Some(Json::Bool(_)))
}

fn valid_speaker(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["kind", "id", "name", "avatar", "club", "machine", "about", "ask"].contains(&key.as_str())
    }) && matches!(map.get("kind"), Some(Json::String(kind)) if kind == "bot")
        && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
        && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120)
        && map.get("avatar").is_none_or(valid_spade_face)
        && map.get("club").is_none_or(|club| {
            matches!(as_map(club), Some(club)
                    if club.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                        && matches!(club.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                        && matches!(club.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120))
        })
        && map.get("machine").is_none_or(|machine| {
            matches!(as_map(machine), Some(machine)
                    if machine.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                        && is_string(machine.get("id"))
                        && is_string(machine.get("name")))
        })
        && matches!(map.get("about"), Some(Json::String(about)) if !about.is_empty() && about.len() <= 256)
        && map.get("ask").is_none_or(|ask| {
            matches!(ask, Json::String(ask) if ask.len() <= 160)
        })
}

fn valid_handoff_citation(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["threadId", "itemId"].contains(&key.as_str()))
        && is_string(map.get("threadId"))
        && optional_string(map.get("itemId"))
}

fn valid_merged_fork(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["sourceThreadId", "summary", "citations", "patchApplied"].contains(&key.as_str())
    }) && is_string(map.get("sourceThreadId"))
        && matches!(map.get("summary"), Some(Json::String(summary)) if !summary.is_empty() && summary.len() <= 256 * 1024)
        && map
            .get("citations")
            .and_then(|citations| citations.as_array())
            .is_some_and(|citations| {
                !citations.is_empty()
                    && citations.len() <= 100
                    && citations.iter().all(valid_handoff_citation)
            })
        && matches!(map.get("patchApplied"), Some(Json::Bool(_)))
}

fn valid_delegation_outcome(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    if map.keys().any(|key| {
        ![
            "failure",
            "threadId",
            "outcome",
            "result",
            "truncated",
            "before",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if let Some(failure) = map.get("failure") {
        if matches!(failure, Json::Null) {
            return false;
        }
        let Some(failure) = as_map(failure) else {
            return false;
        };
        if failure.keys().any(|key| {
            !["code", "message", "accountId", "accountLabel", "resetsAt"].contains(&key.as_str())
        }) {
            return false;
        }
        if !matches!(failure.get("code"), Some(Json::String(code)) if !code.is_empty() && code.len() <= 64)
        {
            return false;
        }
        if !matches!(failure.get("message"), Some(Json::String(message)) if !message.is_empty() && message.len() <= 512)
        {
            return false;
        }
        if let Some(account) = failure.get("accountId")
            && !matches!(account, Json::String(account) if account.len() <= 256)
        {
            return false;
        }
        if let Some(label) = failure.get("accountLabel")
            && !matches!(label, Json::String(label) if label.len() <= 256)
        {
            return false;
        }
        if let Some(resets) = failure.get("resetsAt")
            && !matches!(resets, Json::Number(resets) if resets.as_f64().is_some_and(|resets| resets.is_finite() && resets >= 0.0))
        {
            return false;
        }
    }
    if !is_string(map.get("threadId")) {
        return false;
    }
    if !matches!(
        map.get("outcome"),
        Some(Json::String(outcome)) if ["completed", "failed", "cancelled"].contains(&outcome.as_str())
    ) {
        return false;
    }
    if !matches!(map.get("result"), Some(Json::String(result)) if result.len() <= 4096) {
        return false;
    }
    if !matches!(map.get("truncated"), Some(Json::Bool(_))) {
        return false;
    }
    match map.get("before") {
        None | Some(Json::Null) => true,
        Some(_) => as_integer(map.get("before")).is_some(),
    }
}

fn valid_delegation_status(value: Option<&Json>) -> bool {
    match value {
        Some(Json::String(_)) | Some(Json::Object(_)) => {
            let status = value.cloned().unwrap_or(Json::Null);
            let text = ace_json::to_string(&status);
            serde_json::from_str::<crate::status::ThreadStatus>(&text).is_ok()
        }
        _ => false,
    }
}

/// Whether the merged candidate validates: a strict pass first (like
/// `safeParse`), then a stripped re-validation to tell unknown fields apart
/// from misshapen ones (like `preservesFields`).
pub fn validate_merged_item(candidate: &Map) -> ItemCheck {
    if valid_base(candidate) && valid_item_shape(candidate) {
        return ItemCheck::Ok;
    }
    let (stripped, removed) = crate::validate_unknown::strip_item_unknowns(candidate);
    if removed && valid_base(&stripped) && valid_item_shape(&stripped) {
        ItemCheck::UnknownFields
    } else {
        ItemCheck::Invalid
    }
}

fn valid_item_shape(candidate: &Map) -> bool {
    if !valid_base(candidate) {
        return false;
    }
    let kind = candidate.get("type").and_then(|kind| kind.as_str());
    match kind {
        Some("html") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "visualization",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && valid_html_visualization(candidate.get("visualization"))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("image") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "image",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && valid_shared_image(candidate.get("image"))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("message") => valid_message_shape(candidate),
        Some("delegation.started") => valid_delegation_started(candidate),
        Some("delegation.settled") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "origin",
                    "results",
                    "delivery",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && matches!(candidate.get("origin"), Some(Json::String(origin)) if origin == "ace")
                && candidate
                    .get("results")
                    .and_then(|results| results.as_array())
                    .is_some_and(|results| {
                        !results.is_empty()
                            && results.len() <= 64
                            && results.iter().all(valid_delegation_outcome)
                    })
                && matches!(candidate.get("delivery"), Some(Json::String(delivery)) if delivery == "tool" || delivery == "ace-input")
                && valid_raw_array(candidate.get("raw"))
        }
        Some("reasoning") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "text",
                    "source",
                    "summary",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && is_string(candidate.get("text"))
                && candidate.get("source").is_none_or(valid_text_source)
                && candidate
                    .get("summary")
                    .is_none_or(|summary| matches!(summary, Json::Null | Json::Bool(_)))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("tool_call") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "call",
                    "measurement",
                ]
                .contains(&key.as_str())
            }) && candidate
                .get("call")
                .and_then(as_map)
                .is_some_and(valid_tool_call)
                && candidate.get("measurement").is_none_or(|measurement| {
                    crate::validate_shapes::valid_step_measurement(measurement)
                })
        }
        Some("notice") => valid_notice_shape(candidate),
        Some("compaction") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "tokensBefore",
                    "tokensAfter",
                    "summary",
                    "raw",
                ]
                .contains(&key.as_str())
            }) && candidate
                .get("tokensBefore")
                .is_none_or(|value| as_integer(Some(value)).is_some())
                && candidate
                    .get("tokensAfter")
                    .is_none_or(|value| as_integer(Some(value)).is_some())
                && optional_string(candidate.get("summary"))
                && valid_raw_array(candidate.get("raw"))
        }
        Some("unknown") => {
            candidate.keys().all(|key| {
                [
                    "id",
                    "agentId",
                    "runId",
                    "createdAt",
                    "nativeId",
                    "executionSource",
                    "complete",
                    "inherited",
                    "rawOmitted",
                    "type",
                    "raw",
                    "data",
                ]
                .contains(&key.as_str())
            }) && valid_raw_array(candidate.get("raw"))
                && candidate.contains_key("data")
        }
        Some("artifact") => candidate.keys().all(|key| {
            [
                "id",
                "agentId",
                "runId",
                "createdAt",
                "nativeId",
                "executionSource",
                "complete",
                "inherited",
                "rawOmitted",
                "type",
                "filename",
                "flags",
                "source",
                "artifactId",
                "path",
                "mimeType",
                "bytes",
            ]
            .contains(&key.as_str())
        }) && optional_string(candidate.get("filename"))
            && candidate.get("flags").is_none_or(|flags| {
                matches!(flags, Json::Array(flags) if flags.iter().all(|flag| {
                    matches!(flag, Json::String(flag) if flag == "executable" || flag == "archive")
                }))
            })
            && matches!(candidate.get("source"), Some(Json::String(source)) if source == "browser" || source == "device")
            && candidate.get("artifactId").is_none_or(
                |id| matches!(id, Json::String(id) if !id.is_empty() && id.len() <= 256),
            )
            && is_string(candidate.get("path"))
            && is_string(candidate.get("mimeType"))
            && as_count(candidate.get("bytes")).is_some(),
        _ => false,
    }
}

fn valid_raw_array(value: Option<&Json>) -> bool {
    match value {
        None => true,
        Some(Json::Array(raw)) => raw.iter().all(crate::validate_shapes::valid_raw_payload),
        _ => false,
    }
}

fn valid_html_visualization(value: Option<&Json>) -> bool {
    let Some(map) = value.and_then(as_map) else {
        return false;
    };
    map.keys()
        .all(|key| ["title", "document", "height", "mode", "kit"].contains(&key.as_str()))
        && matches!(map.get("title"), Some(Json::String(title)) if !title.is_empty() && title.len() <= 160)
        && map.get("document").is_some_and(valid_attachment)
}

fn valid_shared_image(value: Option<&Json>) -> bool {
    // Shared images carry the same attachment shape with image bounds.
    value.is_some_and(valid_attachment)
}

fn valid_message_shape(candidate: &Map) -> bool {
    if candidate.keys().any(|key| {
        ![
            "id",
            "agentId",
            "runId",
            "createdAt",
            "nativeId",
            "executionSource",
            "complete",
            "inherited",
            "rawOmitted",
            "type",
            "role",
            "parts",
            "attachments",
            "synthetic",
            "origin",
            "notAnswered",
            "mergedContext",
            "speaker",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        candidate.get("role"),
        Some(Json::String(role)) if role == "user" || role == "assistant"
    ) {
        return false;
    }
    if !candidate
        .get("parts")
        .and_then(|parts| parts.as_array())
        .is_some_and(|parts| parts.iter().all(valid_content_part))
    {
        return false;
    }
    if let Some(attachments) = candidate.get("attachments") {
        if matches!(attachments, Json::Null) {
            return false;
        }
        let valid = match attachments {
            Json::Array(attachments) => {
                attachments.len() <= 64 && attachments.iter().all(valid_attachment)
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    if !candidate
        .get("synthetic")
        .is_none_or(|synthetic| matches!(synthetic, Json::Null | Json::Bool(_)))
    {
        return false;
    }
    if let Some(origin) = candidate.get("origin")
        && (matches!(origin, Json::Null) || !valid_message_origin(origin))
    {
        return false;
    }
    if let Some(not_answered) = candidate.get("notAnswered")
        && (matches!(not_answered, Json::Null)
            || !matches!(not_answered, Json::String(state) if state == "stopped"))
    {
        return false;
    }
    if let Some(merged) = candidate.get("mergedContext")
        && (matches!(merged, Json::Null) || !valid_merged_fork(merged))
    {
        return false;
    }
    if let Some(speaker) = candidate.get("speaker")
        && (matches!(speaker, Json::Null) || !valid_speaker(speaker))
    {
        return false;
    }
    valid_raw_array(candidate.get("raw"))
}

fn valid_notice_shape(candidate: &Map) -> bool {
    if candidate.keys().any(|key| {
        ![
            "id",
            "agentId",
            "runId",
            "createdAt",
            "nativeId",
            "executionSource",
            "complete",
            "inherited",
            "rawOmitted",
            "type",
            "level",
            "commandId",
            "interactionId",
            "code",
            "diagnostic",
            "title",
            "detail",
            "details",
            "toolCallId",
            "measurement",
            "asked",
            "text",
            "source",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(
        candidate.get("level"),
        Some(Json::String(level)) if ["info", "warning", "error"].contains(&level.as_str())
    ) {
        return false;
    }
    for key in [
        "commandId",
        "interactionId",
        "code",
        "title",
        "detail",
        "toolCallId",
    ] {
        if let Some(value) = candidate.get(key)
            && (matches!(value, Json::Null) || !is_string(Some(value)))
        {
            return false;
        }
    }
    if let Some(diagnostic) = candidate.get("diagnostic")
        && (matches!(diagnostic, Json::Null) || !matches!(diagnostic, Json::Bool(_)))
    {
        return false;
    }
    if let Some(details) = candidate.get("details")
        && (matches!(details, Json::Null) || !valid_provider_error_details(details))
    {
        return false;
    }
    if let Some(measurement) = candidate.get("measurement")
        && !crate::validate_shapes::valid_step_measurement(measurement)
    {
        return false;
    }
    if let Some(asked) = candidate.get("asked")
        && !valid_asked_line(asked)
    {
        return false;
    }
    if !is_string(candidate.get("text")) {
        return false;
    }
    if let Some(source) = candidate.get("source")
        && !valid_text_source(source)
    {
        return false;
    }
    valid_raw_array(candidate.get("raw"))
}

fn valid_provider_error_details(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys()
        .all(|key| ["code", "provider", "title", "detail", "model"].contains(&key.as_str()))
        && matches!(map.get("code"), Some(Json::String(code)) if !code.is_empty() && code.len() <= 256)
        && valid_provider_kind(map.get("provider"))
        && map.get("title").is_none_or(|title| {
            matches!(title, Json::Null) | matches!(title, Json::String(title) if title.len() <= 256)
        })
        && map.get("detail").is_none_or(|detail| {
            matches!(detail, Json::Null)
                | matches!(detail, Json::String(detail) if detail.len() <= 2048)
        })
        && map.get("model").is_none_or(|model| {
            matches!(model, Json::Null)
                | matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256)
        })
}

fn valid_delegation_started(candidate: &Map) -> bool {
    if candidate.keys().any(|key| {
        ![
            "id",
            "agentId",
            "runId",
            "createdAt",
            "nativeId",
            "executionSource",
            "complete",
            "inherited",
            "rawOmitted",
            "type",
            "origin",
            "childThreadId",
            "provider",
            "model",
            "accountId",
            "title",
            "role",
            "phase",
            "status",
            "updatedAt",
            "generation",
            "outcome",
            "machine",
            "raw",
        ]
        .contains(&key.as_str())
    }) {
        return false;
    }
    if !matches!(candidate.get("origin"), Some(Json::String(origin)) if origin == "ace") {
        return false;
    }
    if !is_string(candidate.get("childThreadId")) {
        return false;
    }
    if !valid_provider_kind(candidate.get("provider")) {
        return false;
    }
    if let Some(model) = candidate.get("model")
        && (matches!(model, Json::Null)
            || !matches!(model, Json::String(model) if !model.is_empty() && model.len() <= 256))
    {
        return false;
    }
    if let Some(account) = candidate.get("accountId")
        && (matches!(account, Json::Null)
            || !matches!(account, Json::String(account) if !account.is_empty() && account.len() <= 256))
    {
        return false;
    }
    if !matches!(candidate.get("title"), Some(Json::String(title)) if title.len() <= 256) {
        return false;
    }
    if !matches!(candidate.get("role"), Some(Json::String(role)) if role.len() <= 1024) {
        return false;
    }
    if !matches!(
        candidate.get("phase"),
        Some(Json::String(phase)) if ["created", "running", "cancelling", "settled"].contains(&phase.as_str())
    ) {
        return false;
    }
    if !valid_delegation_status(candidate.get("status")) {
        return false;
    }
    if as_count(candidate.get("updatedAt")).is_none() {
        return false;
    }
    if as_count(candidate.get("generation")).is_none() {
        return false;
    }
    if let Some(outcome) = candidate.get("outcome") {
        if matches!(outcome, Json::Null) {
            return false;
        }
        if !valid_delegation_outcome(outcome) {
            return false;
        }
    }
    if let Some(machine) = candidate.get("machine")
        && (matches!(machine, Json::Null) || !valid_agent_machine(Some(machine)))
    {
        return false;
    }
    valid_raw_array(candidate.get("raw"))
}
