// SPDX-License-Identifier: Apache-2.0
//! Transcript upserts and legacy shell aggregates.

use ace_json::JsString;

use crate::emit::{Event, emit, get, put};
use crate::item_delta::append_stored_delta;
use crate::item_model::ToolDetail;
use crate::items::Item;
use crate::items::item_created_at;
use crate::json_io::{Json, Map};
use crate::state::{ApplyContext, ThreadState};

use crate::item_input::{ItemIdentity, item_detail_kind, merge_candidate};

/// Resolve native agent references in a draft detail to ace ids.
fn canonical_detail(
    state: &mut ThreadState,
    key: &str,
    draft: &Map,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<Map> {
    let kind = draft
        .get("kind")
        .and_then(|kind| kind.as_str())
        .unwrap_or("");
    if kind != "agent.spawn" && kind != "agent.message" {
        return Some(draft.clone());
    }
    let (native_key, id_key) = if kind == "agent.spawn" {
        ("childAgent", "childAgentId")
    } else {
        ("targetAgent", "targetAgentId")
    };
    // A spawn or message detail that names no native agent keeps its own fields, like the
    // TypeScript's `canonicalDetail` returning the draft.
    let Some(native) = draft.get(native_key).and_then(|value| value.as_str()) else {
        return Some(draft.clone());
    };
    let linked = {
        crate::tree::ensure_agent(state, native, ctx, events)?;
        get(&state.agents, native)?.agent.id.clone()
    };
    let mut links = get(&state.item_links, key).cloned().unwrap_or_default();
    if kind == "agent.spawn" {
        links.child_agent = Some(native.to_owned());
    } else {
        links.target_agent = Some(native.to_owned());
    }
    put(&mut state.item_links, key.to_owned(), links);
    crate::indexes::register_item_link(state, key);
    let mut detail = draft.clone();
    detail.remove(native_key);
    detail.insert(id_key.to_owned(), Json::from(linked));
    Some(detail)
}

/// Upsert one transcript item, merging the draft over the previous row.
pub fn upsert_item(
    state: &mut ThreadState,
    agent_key: &str,
    key: &str,
    draft: &Map,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<Item> {
    let record_id = {
        let record = crate::tree::ensure_agent(state, agent_key, ctx, events)?;
        record.agent.id.clone()
    };
    let previous = get(&state.items, key).cloned();
    if let Some(previous) = &previous
        && previous.agent_id() != record_id
    {
        return None;
    }
    let base = ItemIdentity {
        id: previous
            .as_ref()
            .map(|item| item.id().to_owned())
            .or_else(|| ctx.ids.next("item"))?,
        agent_id: record_id,
        created_at: previous.as_ref().map(item_created_at).unwrap_or(ctx.now),
        run_id: match &previous {
            Some(previous) => previous.run_id().map(str::to_owned),
            None => get(&state.agents, agent_key).and_then(|record| record.active_run.clone()),
        },
    };
    let draft_detail = draft
        .get("call")
        .and_then(|call| match call {
            Json::Object(map) => map.get("detail"),
            _ => None,
        })
        .and_then(|detail| match detail {
            Json::Object(map) => Some(map),
            _ => None,
        });
    // Validation guarantees the draft detail is an object when present.
    let detail_patch = match draft_detail {
        Some(detail) => canonical_detail(state, key, detail, ctx, events),
        None => None,
    };
    let candidate = merge_candidate(
        previous.as_ref(),
        &base,
        draft,
        ctx.now,
        detail_patch.as_ref(),
    );
    let mut item: Item = crate::json_io::decode(&Json::Object(candidate)).ok()?;
    // Legacy output strings become suffix deltas: restore the verified stream
    // first, then append only the new aggregate bytes.
    let legacy = legacy_aggregate(previous.as_ref(), draft, &item);
    if let Some(_aggregate) = &legacy
        && let Item::ToolCall { call, .. } = &mut item
        && matches!(&call.detail, ToolDetail::Shell { .. })
    {
        let prior = match &previous {
            Some(Item::ToolCall { call, .. }) => match &call.detail {
                ToolDetail::Shell { output, .. } => output.clone(),
                _ => None,
            },
            _ => None,
        };
        // packages/core/src/items.ts:78-79 changes only the existing shell output.
        if let ToolDetail::Shell { output, .. } = &mut call.detail {
            *output = prior;
        }
    }
    let created = previous.is_none();
    put(&mut state.items, key.to_owned(), item);
    crate::indexes::refresh_item_index(state, key);
    let stored = get(&state.items, key)?.clone();
    emit(
        events,
        if created {
            Event::ItemCreated {
                item: stored.clone(),
            }
        } else {
            Event::ItemUpdated {
                item: stored.clone(),
            }
        },
    );
    if let Some(aggregate) = legacy {
        let prior_bytes = match &previous {
            Some(Item::ToolCall { call, .. }) => match &call.detail {
                ToolDetail::Shell { output, .. } => output.as_ref().map(|summary| summary.bytes),
                _ => None,
            },
            _ => None,
        };
        let suffix = aggregate
            .as_bytes()
            .get(prior_bytes.unwrap_or(0).max(0) as usize..)
            .map(String::from_utf8_lossy)
            .unwrap_or_default()
            .into_owned();
        append_stored_delta(state, key, "output", &JsString::from(suffix), events)?;
    }
    if let Some(Item::ToolCall { call, .. }) = get(&state.items, key)
        && matches!(&call.detail, ToolDetail::AgentSpawn { .. })
    {
        let child = get(&state.item_links, key).and_then(|links| links.child_agent.clone());
        let child_record = child.as_ref().and_then(|child| get(&state.agents, child));
        let explicit_spawn = draft_detail.is_some_and(|detail| {
            detail.get("kind").and_then(|kind| kind.as_str()) == Some("agent.spawn")
                && detail.get("childAgent").is_some()
        });
        // A refresh of a historical spawning item cannot undo an
        // authoritative reparenting.
        if child.is_some()
            && (previous.is_none()
                || explicit_spawn
                || child_record
                    .is_some_and(|record| record.parent_key.as_deref() == Some(agent_key)))
        {
            let child = child.unwrap_or_default();
            crate::tree::link_agent(
                state,
                &crate::facts::Fact::AgentLinked {
                    agent: child,
                    parent: Some(agent_key.to_owned()),
                    spawned_by: Some(key.to_owned()),
                    background: None,
                    name: None,
                    model: None,
                },
                ctx,
                events,
            )?;
        }
    }
    get(&state.items, key).cloned()
}

/// The legacy shell aggregate the draft extends, if the draft carries one.
fn legacy_aggregate(previous: Option<&Item>, draft: &Map, item: &Item) -> Option<String> {
    if item_detail_kind(previous, draft).as_deref() != Some("shell") {
        return None;
    }
    let detail = draft
        .get("call")
        .and_then(|call| match call {
            Json::Object(map) => map.get("detail"),
            _ => None,
        })
        .and_then(|detail| match detail {
            Json::Object(map) => Some(map),
            _ => None,
        })?;
    if !detail.contains_key("output") {
        return None;
    }
    let aggregate = detail.get("output").and_then(|output| output.as_str())?;
    if !matches!(item, Item::ToolCall { call, .. } if matches!(&call.detail, ToolDetail::Shell { .. }))
    {
        return None;
    }
    Some(aggregate.to_owned())
}
