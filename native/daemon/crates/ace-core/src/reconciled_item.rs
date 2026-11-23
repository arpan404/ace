// SPDX-License-Identifier: Apache-2.0
//! The snapshot reconciliation of `reconciled-item.ts`: native snapshots
//! reconcile against canonical state, never against evictable adapter hints.

use crate::emit::Event;
use crate::item_input::{detail_candidate, merge_candidate};
use crate::item_model::ToolDetail;
use crate::items::Item;
use crate::json_io::{Json, Map};
use crate::output_snapshot::extends_output;
use crate::state::{ApplyContext, ThreadState};

/// Reconcile one native snapshot against the canonical item.
pub fn reconcile_item(
    state: &mut ThreadState,
    agent_key: &str,
    key: &str,
    draft: &Map,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<Item> {
    let previous = crate::emit::get(&state.items, key).cloned();
    if let Some(previous) = &previous {
        if previous.complete()
            && draft.get("complete").and_then(|value| value.as_bool()) == Some(false)
        {
            return Some(previous.clone());
        }
    }
    if draft.get("type").and_then(|kind| kind.as_str()) != Some("tool_call") {
        return super::items::upsert_item(state, agent_key, key, draft, ctx, events);
    }
    if !matches!(previous, Some(Item::ToolCall { .. })) {
        return super::items::upsert_item(state, agent_key, key, draft, ctx, events);
    }
    let previous = previous?;
    let previous_call = match &previous {
        Item::ToolCall { call, .. } => call,
        _ => return None,
    };
    let mut call = match draft.get("call") {
        Some(Json::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let first_raw = previous_call.raw.first().and_then(|raw| {
        ace_json::ser::to_string(raw)
            .ok()
            .and_then(|text| ace_json::parse(&text).ok())
    });
    if let (Some(first), Some(Json::Array(raw))) = (first_raw, call.get("raw")) {
        if !raw.is_empty() {
            let mut kept = vec![first];
            if let Some(last) = raw.last() {
                kept.push(last.clone());
            }
            call.insert("raw".to_owned(), Json::from(kept));
        }
    }
    if let Some(Json::Object(detail)) = call.get("detail").cloned() {
        if detail.get("kind").and_then(|kind| kind.as_str()) == Some("shell") {
            let prior_output = match &previous_call.detail {
                ToolDetail::Shell { output, .. } => output.clone(),
                _ => None,
            };
            let aggregate = detail
                .get("output")
                .and_then(|output| output.as_str())
                .map(str::to_owned);
            if let Some(aggregate) = aggregate {
                if !extends_output(prior_output.as_ref(), &aggregate) {
                    // Missing native chunks cannot be inserted into an
                    // append-only stream. Keep the complete aggregate in raw
                    // while preserving verified output.
                    let mut metadata = detail;
                    metadata.remove("output");
                    call.insert("detail".to_owned(), Json::Object(metadata));
                }
            }
        }
    }
    let mut reconciled = draft.clone();
    reconciled.insert("call".to_owned(), Json::Object(call));
    super::items::upsert_item(state, agent_key, key, &reconciled, ctx, events)
}

/// Build the detail candidate for validation (no state access).
pub fn reconcile_detail_candidate(detail: &Map) -> Map {
    detail_candidate(detail)
}
