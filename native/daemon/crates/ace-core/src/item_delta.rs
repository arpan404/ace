// SPDX-License-Identifier: Apache-2.0
//! Streaming transcript deltas and partial item materialization.

use ace_json::JsString;

use crate::delta_text::{
    OutputSummaryData, OutputSummaryView, append_text, output_deltas, summarize_output,
};
use crate::emit::{Event, emit, get};
use crate::item_model::{ContentPart, OutputSummary, ToolDetail};
use crate::items::Item;
use crate::items::upsert_item;
use crate::json_io::{Json, Map};
use crate::state::{ApplyContext, ThreadState};

/// Whether `applyDelta(item, field, append)` would change `item`.
fn delta_changes(item: &Item, field: &str, append: &JsString) -> bool {
    if !append.is_empty() {
        return true;
    }
    if field == "output" {
        return matches!(item, Item::ToolCall { call, .. } if matches!(&call.detail, ToolDetail::Shell { output: None, .. }));
    }
    match item {
        Item::Message { parts, .. } => {
            field == "text" && !matches!(parts.last(), Some(ContentPart::Text { .. }))
        }
        _ => false,
    }
}

/// Whether a delta applies to an item without mutation.
fn accepts_delta(item: &Item, field: &str) -> bool {
    if field == "output" {
        return matches!(item, Item::ToolCall { call, .. } if matches!(&call.detail, ToolDetail::Shell { .. }));
    }
    match item {
        Item::Reasoning { .. } | Item::Notice { .. } => true,
        Item::Message { .. } => field == "text",
        _ => false,
    }
}

/// Append one delta to the stored item, emitting `item.delta` when it changes.
pub(crate) fn append_stored_delta(
    state: &mut ThreadState,
    key: &str,
    field: &str,
    append: &JsString,
    events: &mut Vec<Event>,
) -> Option<()> {
    if !get(&state.items, key).is_some_and(|item| accepts_delta(item, field)) {
        return None;
    }
    // An append that changes nothing is applied for its checks but sends no
    // event: a client would fold it to the same item.
    let changes = get(&state.items, key).is_some_and(|item| delta_changes(item, field, append));
    let item_id = get(&state.items, key)?.id().to_owned();
    let agent_id = get(&state.items, key)?.agent_id().to_owned();
    apply_delta_to_stored(state, key, field, append)?;
    if !changes {
        return Some(());
    }
    if field == "output" {
        for part in output_deltas(append) {
            emit(
                events,
                Event::ItemDelta {
                    item_id: item_id.clone(),
                    agent_id: agent_id.clone(),
                    field: field.to_owned(),
                    append: JsString::from(part),
                },
            );
        }
    } else {
        emit(
            events,
            Event::ItemDelta {
                item_id,
                agent_id,
                field: field.to_owned(),
                append: append.clone(),
            },
        );
    }
    Some(())
}

/// Apply one delta's content to the stored item.
fn apply_delta_to_stored(
    state: &mut ThreadState,
    key: &str,
    field: &str,
    append: &JsString,
) -> Option<()> {
    match state.items.get_mut(key)? {
        Item::ToolCall { call, .. } if field == "output" => {
            // packages/projection/src/delta.ts:227 replaces output on the existing detail.
            if let ToolDetail::Shell { output, .. } = &mut call.detail {
                let previous = output.as_ref().map(|summary| OutputSummaryView {
                    stream_id: summary.stream_id.clone(),
                    bytes: summary.bytes,
                    tail: summary.tail.clone(),
                });
                let summary: OutputSummaryData =
                    summarize_output(&call.id, append.as_str(), previous.as_ref());
                *output = Some(OutputSummary {
                    stream_id: summary.stream_id,
                    bytes: summary.bytes,
                    tail: summary.tail,
                    truncated: summary.truncated,
                });
                return Some(());
            }
            None
        }
        Item::Reasoning { text, source, .. } if field != "output" => {
            let mut source_data = source
                .as_ref()
                .map(|source| crate::delta_text::TextSourceData {
                    bytes: source.bytes,
                    offset: source.offset,
                });
            append_text(text, &mut source_data, append);
            *source = source_data.map(|data| crate::item_model::TextSource {
                stream_id: source
                    .as_ref()
                    .map(|source| source.stream_id.clone())
                    .unwrap_or_default(),
                bytes: data.bytes,
                encoding: "utf-16le".to_owned(),
                offset: data.offset,
            });
            Some(())
        }
        Item::Notice { text, source, .. } if field != "output" => {
            let mut source_data = source
                .as_ref()
                .map(|source| crate::delta_text::TextSourceData {
                    bytes: source.bytes,
                    offset: source.offset,
                });
            append_text(text, &mut source_data, append);
            *source = source_data.map(|data| crate::item_model::TextSource {
                stream_id: source
                    .as_ref()
                    .map(|source| source.stream_id.clone())
                    .unwrap_or_default(),
                bytes: data.bytes,
                encoding: "utf-16le".to_owned(),
                offset: data.offset,
            });
            Some(())
        }
        Item::Message { parts, .. } if field == "text" => {
            match parts.last_mut() {
                // packages/projection/src/delta.ts:232 appends to the existing text part.
                Some(ContentPart::Text { text, source, .. }) => {
                    let mut source_data =
                        source
                            .as_ref()
                            .map(|source| crate::delta_text::TextSourceData {
                                bytes: source.bytes,
                                offset: source.offset,
                            });
                    append_text(text, &mut source_data, append);
                    *source = source_data.map(|data| crate::item_model::TextSource {
                        stream_id: source
                            .as_ref()
                            .map(|source| source.stream_id.clone())
                            .unwrap_or_default(),
                        bytes: data.bytes,
                        encoding: "utf-16le".to_owned(),
                        offset: data.offset,
                    });
                }
                // packages/projection/src/delta.ts:233 creates a fresh text part.
                _ => parts.push(ContentPart::text(append.clone())),
            }
            Some(())
        }
        _ => None,
    }
}

/// Unknown items are materialized, so chunks from partial streams survive.
pub fn append_item(
    state: &mut ThreadState,
    agent_key: &str,
    item_key: &str,
    field: &str,
    append: &JsString,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<bool> {
    let record_id = {
        let record = crate::tree::ensure_agent(state, agent_key, ctx, events)?;
        record.agent.id.clone()
    };
    let created = !state.items.contains_key(item_key);
    if created {
        let draft = match field {
            "reasoning" => {
                let mut draft = Map::new();
                draft.insert("type".to_owned(), Json::from("reasoning".to_owned()));
                draft.insert("text".to_owned(), Json::from(String::new()));
                draft
            }
            "output" => {
                let mut call = Map::new();
                call.insert("kind".to_owned(), Json::from("shell".to_owned()));
                call.insert("title".to_owned(), Json::from("Output".to_owned()));
                call.insert("status".to_owned(), Json::from("running".to_owned()));
                // packages/core/src/items.ts:132 creates a fresh shell detail.
                let mut detail = Map::new();
                detail.insert("kind".to_owned(), Json::from("shell".to_owned()));
                detail.insert("command".to_owned(), Json::from(String::new()));
                call.insert("detail".to_owned(), Json::Object(detail));
                let mut draft = Map::new();
                draft.insert("type".to_owned(), Json::from("tool_call".to_owned()));
                draft.insert("call".to_owned(), Json::Object(call));
                draft
            }
            _ => {
                let mut draft = Map::new();
                draft.insert("type".to_owned(), Json::from("message".to_owned()));
                draft.insert("role".to_owned(), Json::from("assistant".to_owned()));
                draft.insert("parts".to_owned(), Json::from(Vec::<Json>::new()));
                draft
            }
        };
        upsert_item(state, agent_key, item_key, &draft, ctx, events)?;
    }
    let owner = get(&state.items, item_key)?.agent_id().to_owned();
    if owner != record_id {
        return None;
    }
    append_stored_delta(state, item_key, field, append, events)?;
    let activity = match get(&state.items, item_key)? {
        Item::Reasoning { .. } => Some("thinking"),
        Item::ToolCall { .. } => Some("tool"),
        Item::Message { role, .. } if role == "assistant" => Some("responding"),
        _ => None,
    };
    let changed = get(&state.agents, agent_key).is_some_and(|record| {
        record.active_run.is_some()
            && get(&state.items, item_key).and_then(|item| item.run_id())
                == record.active_run.as_deref()
            && activity.is_some_and(|activity| record.activity != activity)
    });
    if changed && let Some(record) = state.agents.get_mut(agent_key) {
        record.activity = activity.unwrap_or_default().to_owned();
        record.detail = None;
    }
    let unresponsive = get(&state.agents, agent_key)
        .map(|record| record.agent.status.state() == "unresponsive")
        .unwrap_or(false);
    Some(created || changed || unresponsive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_io::{parse_typed, to_value};
    use crate::state::{CoreConfig, create_thread_state};

    #[test]
    fn content_part_extras_round_trip_and_stay_with_the_original_part() {
        let mut state = create_thread_state(
            "t".to_owned(),
            None,
            CoreConfig {
                provider: "claude".to_owned(),
                silence_ms: 30_000.0,
                liveness: None,
            },
        )
        .unwrap();
        let mut ids = |kind: &str| Some(kind.to_owned());
        let mut ctx = ApplyContext {
            now: 1,
            ids: &mut ids,
            resolving_interactions: None,
        };
        let mut events = Vec::new();
        let agent_id = crate::tree::ensure_agent(&mut state, "a", &mut ctx, &mut events)
            .unwrap()
            .agent
            .id
            .clone();
        let item = parse_typed(&format!(
            r#"{{"type":"message","id":"i","agentId":"{agent_id}","createdAt":1,
              "parts":[{{"type":"text","text":"a","future":[1,null]}}],"role":"assistant"}}"#,
        ))
        .unwrap();
        state.items.insert("i".to_owned(), item);
        append_item(
            &mut state,
            "a",
            "i",
            "text",
            &JsString::from("b"),
            &mut ctx,
            &mut events,
        )
        .unwrap();
        let Item::Message { parts, .. } = &state.items["i"] else {
            panic!("expected a message");
        };
        let stored = ace_json::ser::to_string(&parts[0]).unwrap();
        assert_eq!(stored, r#"{"type":"text","text":"ab","future":[1,null]}"#);
        assert!(matches!(parts[0], ContentPart::Text { .. }));

        let replacement = parse_typed(r#"{"type":"message","parts":[{"type":"image","mimeType":"image/png","url":"https://example.com/image.png"}]}"#)
            .unwrap();
        upsert_item(&mut state, "a", "i", &replacement, &mut ctx, &mut events).unwrap();
        append_item(
            &mut state,
            "a",
            "i",
            "text",
            &JsString::from("c"),
            &mut ctx,
            &mut events,
        )
        .unwrap();
        let Item::Message { parts, .. } = &state.items["i"] else {
            panic!("expected a message");
        };
        assert_eq!(
            to_value(parts),
            parse_typed::<Json>(
                r#"[{"type":"image","mimeType":"image/png","url":"https://example.com/image.png"},{"type":"text","text":"c"}]"#
            ).unwrap()
        );
    }
}
