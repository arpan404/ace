// SPDX-License-Identifier: Apache-2.0
//! The item preflight run before an upsert or reconciliation fact is accepted.

use super::{ItemCheck, as_map, get_str, optional_string, validate_merged_item};
use crate::emit::get;
use crate::item_input::{detail_candidate, item_detail_kind, merge_candidate};
use crate::items::Item;
use crate::json_io::{Json, Map};
use crate::output_snapshot::extends_output;
use crate::state::{AgentRecord, ThreadState};
use crate::validate::relation_error;

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
