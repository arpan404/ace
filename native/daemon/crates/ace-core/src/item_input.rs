// SPDX-License-Identifier: Apache-2.0
//! The pure candidate construction of `item-input.ts`: merging a draft over
//! the previous item lets validation finish before identity allocation.
//! Transient maps only; the fold converts validated candidates to `Item`.

use crate::delta_text::{OutputSummaryData, summarize_output};
use crate::item_model::{OutputSummary, ToolCall, ToolDetail};
use crate::items::Item;
use crate::json_io::{Json, Map};

/// The identity core allocates for an item candidate.
pub struct ItemIdentity {
    /// The item's ace id.
    pub id: String,
    /// The owning agent's ace id.
    pub agent_id: String,
    /// When the item was created.
    pub created_at: i64,
    /// The run the item belongs to.
    pub run_id: Option<String>,
}

fn draft_call(patch: &Map) -> Option<&Map> {
    match patch.get("call") {
        Some(Json::Object(map)) => Some(map),
        _ => None,
    }
}

fn draft_detail(patch: &Map) -> Option<&Map> {
    draft_call(patch).and_then(|call| match call.get("detail") {
        Some(Json::Object(map)) => Some(map),
        _ => None,
    })
}

fn str_field<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|value| value.as_str())
}

/// Partial details inherit their kind from the call or existing item.
pub fn item_detail_kind(previous: Option<&Item>, patch: &Map) -> Option<String> {
    if patch.get("type").and_then(|kind| kind.as_str()) != Some("tool_call") {
        return None;
    }
    if let Some(kind) = draft_detail(patch).and_then(|detail| str_field(detail, "kind")) {
        return Some(kind.to_owned());
    }
    if let Some(kind) = draft_call(patch).and_then(|call| str_field(call, "kind")) {
        return Some(kind.to_owned());
    }
    match previous {
        Some(Item::ToolCall { call, .. }) => Some(tool_detail_kind(&call.detail).to_owned()),
        _ => None,
    }
}

/// The kind of a stored tool detail.
pub fn tool_detail_kind(detail: &ToolDetail) -> &str {
    match detail {
        ToolDetail::Shell { .. } => "shell",
        ToolDetail::FileRead { .. } => "file.read",
        ToolDetail::FileEdit { .. } => "file.edit",
        ToolDetail::FileWrite { .. } => "file.write",
        ToolDetail::FileDelete { .. } => "file.delete",
        ToolDetail::FileMove { .. } => "file.move",
        ToolDetail::Search { .. } => "search",
        ToolDetail::WebSearch { .. } => "web.search",
        ToolDetail::WebFetch { .. } => "web.fetch",
        ToolDetail::Mcp { .. } => "mcp",
        ToolDetail::AgentSpawn { .. } => "agent.spawn",
        ToolDetail::AgentMessage { .. } => "agent.message",
        ToolDetail::Todo { .. } => "todo",
        ToolDetail::Plan { .. } => "plan",
        ToolDetail::AskUser => "ask_user",
        ToolDetail::Image { .. } => "image",
        ToolDetail::Browser => "browser",
        ToolDetail::Notebook => "notebook",
        ToolDetail::Custom => "custom",
    }
}

/// Rename native agent references to ace ids for validation, without state.
pub fn detail_candidate(detail: &Map) -> Map {
    let mut candidate = detail.clone();
    if candidate.get("kind").and_then(|kind| kind.as_str()) == Some("agent.spawn") {
        if let Some(child) = candidate.remove("childAgent") {
            candidate.insert("childAgentId".to_owned(), child);
        }
    }
    if candidate.get("kind").and_then(|kind| kind.as_str()) == Some("agent.message") {
        if let Some(target) = candidate.remove("targetAgent") {
            candidate.insert("targetAgentId".to_owned(), target);
        }
    }
    candidate
}

/// Merge a draft over the previous item into a validation candidate.
pub fn merge_candidate(
    previous: Option<&Item>,
    base: &ItemIdentity,
    patch: &Map,
    now: i64,
    detail_patch: Option<&Map>,
) -> Map {
    let patch_type = patch.get("type").and_then(|kind| kind.as_str());
    if patch_type == Some("tool_call") {
        return merge_tool_candidate(previous, base, patch, now, detail_patch);
    }
    let mut candidate = Map::new();
    candidate.insert("complete".to_owned(), Json::Bool(false));
    match patch_type {
        Some("message") => {
            candidate.insert("role".to_owned(), Json::from("assistant".to_owned()));
            candidate.insert("parts".to_owned(), Json::from(Vec::<Json>::new()));
        }
        Some("reasoning") => {
            candidate.insert("text".to_owned(), Json::from(String::new()));
        }
        Some("notice") => {
            candidate.insert("level".to_owned(), Json::from("info".to_owned()));
            candidate.insert("text".to_owned(), Json::from(String::new()));
        }
        _ => {}
    }
    if let Some(previous) = previous {
        if previous.item_type() == patch_type.unwrap_or("") {
            overlay_value(&mut candidate, &to_map(previous));
        }
    }
    overlay(&mut candidate, patch);
    candidate.insert("id".to_owned(), Json::from(base.id.clone()));
    candidate.insert("agentId".to_owned(), Json::from(base.agent_id.clone()));
    candidate.insert("createdAt".to_owned(), Json::Number(now.into()));
    if let Some(run_id) = &base.run_id {
        candidate.insert("runId".to_owned(), Json::from(run_id.clone()));
    }
    candidate
}

fn merge_tool_candidate(
    previous: Option<&Item>,
    base: &ItemIdentity,
    patch: &Map,
    now: i64,
    detail_patch: Option<&Map>,
) -> Map {
    let previous_call = match previous {
        Some(Item::ToolCall { call, .. }) => Some(call),
        _ => None,
    };
    let empty = Map::new();
    let patch_call = draft_call(patch).unwrap_or(&empty);
    let normalized = crate::ace_tools::normalize_ace_call(patch_call, previous_call);
    let mut call_map = normalized;
    let mut detail_patch = detail_patch.cloned().unwrap_or_default();
    if call_map.get("detail").and_then(|detail| match detail {
        Json::Object(map) => str_field(map, "kind"),
        _ => None,
    }) == Some("mcp")
    {
        if let Some(Json::Object(detail)) = call_map.get("detail") {
            detail_patch = detail.clone();
        }
    }
    let prior_call_value = previous_call
        .and_then(|call| {
            ace_json::ser::to_string(call)
                .ok()
                .and_then(|text| ace_json::parse(&text).ok())
        })
        .unwrap_or(Json::Null);
    let kind = str_field(&call_map, "kind")
        .map(str::to_owned)
        .or_else(|| item_detail_kind(previous, patch))
        .unwrap_or_else(|| "custom".to_owned());
    // `output` summaries belong to core; adapters append output deltas.
    detail_patch.remove("output");
    // The prior detail carries over only when its kind is the draft detail's
    // kind (or the call kind when the draft names none); else a kind marker.
    let draft_detail_kind = draft_detail(patch).and_then(|detail| str_field(detail, "kind"));
    let mut merged_detail = prior_merged_detail(&prior_call_value, draft_detail_kind, &kind);
    overlay(&mut merged_detail, &detail_patch);
    if merged_detail.get("kind").and_then(|kind| kind.as_str()) == Some("shell") {
        if let Some(Json::String(output)) = merged_detail.get("output").cloned() {
            let summary: OutputSummaryData = summarize_output(&base.id, &output, None);
            let output_value = ace_json::ser::to_string(&OutputSummary {
                stream_id: summary.stream_id,
                bytes: summary.bytes,
                tail: summary.tail,
                truncated: summary.truncated,
            })
            .ok()
            .and_then(|text| ace_json::parse(&text).ok())
            .unwrap_or(Json::Null);
            merged_detail.insert("output".to_owned(), output_value);
        }
        merged_detail.remove("outputTruncated");
    }
    let mut candidate = Map::new();
    candidate.insert("complete".to_owned(), Json::Bool(false));
    if let Some(previous) = previous {
        if previous.item_type() == "tool_call" {
            overlay_value(&mut candidate, &to_map(previous));
        }
    }
    overlay(&mut candidate, patch);
    candidate.insert("id".to_owned(), Json::from(base.id.clone()));
    candidate.insert("agentId".to_owned(), Json::from(base.agent_id.clone()));
    candidate.insert("createdAt".to_owned(), Json::Number(now.into()));
    if let Some(run_id) = &base.run_id {
        candidate.insert("runId".to_owned(), Json::from(run_id.clone()));
    }
    let mut call = Map::new();
    call.insert("title".to_owned(), Json::from(kind.clone()));
    call.insert("status".to_owned(), Json::from("pending".to_owned()));
    call.insert("startedAt".to_owned(), Json::Number(now.into()));
    call.insert("raw".to_owned(), Json::from(Vec::<Json>::new()));
    if let Json::Object(prior) = &prior_call_value {
        overlay(&mut call, prior);
    }
    overlay(&mut call, &call_map);
    call.insert("id".to_owned(), Json::from(base.id.clone()));
    call.insert("agentId".to_owned(), Json::from(base.agent_id.clone()));
    call.insert("kind".to_owned(), Json::from(kind));
    call.insert("detail".to_owned(), Json::Object(merged_detail));
    candidate.insert("call".to_owned(), Json::Object(call));
    candidate
}

/// The prior detail when its kind is the draft's, else a fresh kind marker.
fn prior_merged_detail(
    prior_call_value: &Json,
    normalized_detail_kind: Option<&str>,
    kind: &str,
) -> Map {
    let prior_detail = prior_call_value
        .get("detail")
        .and_then(|detail| match detail {
            Json::Object(map) => Some(map),
            _ => None,
        });
    let same = prior_detail
        .is_some_and(|prior| str_field(prior, "kind") == normalized_detail_kind.or(Some(kind)));
    if same {
        prior_detail.cloned().unwrap_or_default()
    } else {
        Map::from_iter([("kind".to_owned(), Json::from(kind.to_owned()))])
    }
}

fn overlay(target: &mut Map, source: &Map) {
    for (key, value) in source.iter() {
        target.insert(key.clone(), value.clone());
    }
}

fn overlay_value(target: &mut Map, source: &Json) {
    if let Json::Object(map) = source {
        overlay(target, map);
    }
}

fn to_map(item: &Item) -> Json {
    ace_json::ser::to_string(item)
        .ok()
        .and_then(|text| ace_json::parse(&text).ok())
        .unwrap_or(Json::Null)
}
