// SPDX-License-Identifier: Apache-2.0
//! The transcript items of `items.ts`: upserting canonical items, appending
//! streaming deltas, and the legacy shell-output path. Every variant keeps
//! its protocol JSON exactly; `validate` admits only canonical candidates.

use serde::{Deserialize, Serialize};

use crate::emit::{Event, emit, get, put};
use crate::entity_model::BackgroundTask;
use crate::item_meta::{DelegationOutcome, DelegationSettled, DelegationStarted};
use crate::item_model::{
    Attachment, ContentPart, OutputSummary, RawPayload, TextSource, ToolCall, ToolDetail, Vetted,
};
use crate::json_io::{Json, Map};
use crate::state::{ApplyContext, ThreadState};

/// Agent-owned transcript entries, plus the thread-level rows the core folds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Item {
    /// A visualization.
    #[serde(rename = "html")]
    Html {
        #[serde(flatten)]
        base: ItemBase,
        visualization: Vetted,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A shared image.
    #[serde(rename = "image")]
    Image {
        #[serde(flatten)]
        base: ItemBase,
        image: Vetted,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A user or assistant message.
    #[serde(rename = "message")]
    Message {
        #[serde(flatten)]
        base: ItemBase,
        role: String,
        #[serde(default)]
        parts: Vec<ContentPart>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<Attachment>>,
        #[serde(default)]
        synthetic: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<crate::item_meta::MessageOrigin>,
        #[serde(rename = "notAnswered", skip_serializing_if = "Option::is_none")]
        not_answered: Option<String>,
        #[serde(rename = "mergedContext", skip_serializing_if = "Option::is_none")]
        merged_context: Option<Vetted>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<crate::item_meta::Speaker>,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A delegated child thread started.
    #[serde(rename = "delegation.started")]
    DelegationStarted {
        #[serde(flatten)]
        base: ItemBase,
        #[serde(flatten)]
        delegation: DelegationStarted,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A delegated child thread settled.
    #[serde(rename = "delegation.settled")]
    DelegationSettled {
        #[serde(flatten)]
        base: ItemBase,
        #[serde(flatten)]
        delegation: DelegationSettled,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// Provider thinking.
    #[serde(rename = "reasoning")]
    Reasoning {
        #[serde(flatten)]
        base: ItemBase,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<TextSource>,
        #[serde(default)]
        summary: bool,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// One tool call.
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(flatten)]
        base: ItemBase,
        call: ToolCall,
        #[serde(skip_serializing_if = "Option::is_none")]
        measurement: Option<Vetted>,
    },
    /// A notice: warnings, errors, and adapter evidence.
    #[serde(rename = "notice")]
    Notice {
        #[serde(flatten)]
        base: ItemBase,
        level: String,
        #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        #[serde(rename = "interactionId", skip_serializing_if = "Option::is_none")]
        interaction_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostic: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<crate::status::ProviderErrorDetails>,
        #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        measurement: Option<Vetted>,
        #[serde(skip_serializing_if = "Option::is_none")]
        asked: Option<crate::item_meta::AskedLine>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<TextSource>,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A compaction summary.
    #[serde(rename = "compaction")]
    Compaction {
        #[serde(flatten)]
        base: ItemBase,
        #[serde(rename = "tokensBefore", skip_serializing_if = "Option::is_none")]
        tokens_before: Option<i64>,
        #[serde(rename = "tokensAfter", skip_serializing_if = "Option::is_none")]
        tokens_after: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default)]
        raw: Vec<RawPayload>,
    },
    /// A newer-than-this-build item, kept whole.
    #[serde(rename = "unknown")]
    Unknown {
        #[serde(flatten)]
        base: ItemBase,
        #[serde(default)]
        raw: Vec<RawPayload>,
        data: Vetted,
    },
    /// A thread artifact from before an agent started.
    #[serde(rename = "artifact")]
    Artifact {
        #[serde(flatten)]
        base: ArtifactBase,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        flags: Option<Vec<String>>,
        source: String,
        #[serde(rename = "artifactId", skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        path: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        bytes: i64,
    },
}

/// The identity and liveness fields every item carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemBase {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// Exact inclusive native fork boundary, when the adapter establishes it.
    #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(rename = "executionSource", skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<Vetted>,
    /// False while the provider still streams into this item.
    #[serde(default = "default_true")]
    pub complete: bool,
    /// The source thread's, in a fork.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited: Option<Vetted>,
    /// Sent to a client whose hello asked for raw on demand; never stored.
    #[serde(rename = "rawOmitted", skip_serializing_if = "Option::is_none")]
    pub raw_omitted: Option<bool>,
}

fn default_true() -> bool {
    true
}

/// The artifact base: artifacts can exist before the first agent starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactBase {
    pub id: String,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(rename = "executionSource", skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<Vetted>,
    #[serde(default = "default_true")]
    pub complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited: Option<Vetted>,
    #[serde(rename = "rawOmitted", skip_serializing_if = "Option::is_none")]
    pub raw_omitted: Option<bool>,
}

impl Item {
    /// The item's protocol type tag.
    pub fn item_type(&self) -> &str {
        match self {
            Self::Html { .. } => "html",
            Self::Image { .. } => "image",
            Self::Message { .. } => "message",
            Self::DelegationStarted { .. } => "delegation.started",
            Self::DelegationSettled { .. } => "delegation.settled",
            Self::Reasoning { .. } => "reasoning",
            Self::ToolCall { .. } => "tool_call",
            Self::Notice { .. } => "notice",
            Self::Compaction { .. } => "compaction",
            Self::Unknown { .. } => "unknown",
            Self::Artifact { .. } => "artifact",
        }
    }

    /// False while the provider still streams into this item.
    pub fn complete(&self) -> bool {
        match self {
            Self::Html { base, .. } => base.complete,
            Self::Image { base, .. } => base.complete,
            Self::Message { base, .. } => base.complete,
            Self::DelegationStarted { base, .. } => base.complete,
            Self::DelegationSettled { base, .. } => base.complete,
            Self::Reasoning { base, .. } => base.complete,
            Self::ToolCall { base, .. } => base.complete,
            Self::Notice { base, .. } => base.complete,
            Self::Compaction { base, .. } => base.complete,
            Self::Unknown { base, .. } => base.complete,
            Self::Artifact { base, .. } => base.complete,
        }
    }

    /// The owning agent's ace id.
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Html { base, .. } => &base.agent_id,
            Self::Image { base, .. } => &base.agent_id,
            Self::Message { base, .. } => &base.agent_id,
            Self::DelegationStarted { base, .. } => &base.agent_id,
            Self::DelegationSettled { base, .. } => &base.agent_id,
            Self::Reasoning { base, .. } => &base.agent_id,
            Self::ToolCall { base, .. } => &base.agent_id,
            Self::Notice { base, .. } => &base.agent_id,
            Self::Compaction { base, .. } => &base.agent_id,
            Self::Unknown { base, .. } => &base.agent_id,
            Self::Artifact { base, .. } => base.agent_id.as_deref().unwrap_or(""),
        }
    }

    /// The item's ace id.
    pub fn id(&self) -> &str {
        match self {
            Self::Html { base, .. } => &base.id,
            Self::Image { base, .. } => &base.id,
            Self::Message { base, .. } => &base.id,
            Self::DelegationStarted { base, .. } => &base.id,
            Self::DelegationSettled { base, .. } => &base.id,
            Self::Reasoning { base, .. } => &base.id,
            Self::ToolCall { base, .. } => &base.id,
            Self::Notice { base, .. } => &base.id,
            Self::Compaction { base, .. } => &base.id,
            Self::Unknown { base, .. } => &base.id,
            Self::Artifact { base, .. } => &base.id,
        }
    }

    /// The run the item belongs to.
    pub fn run_id(&self) -> Option<&str> {
        match self {
            Self::Html { base, .. } => base.run_id.as_deref(),
            Self::Image { base, .. } => base.run_id.as_deref(),
            Self::Message { base, .. } => base.run_id.as_deref(),
            Self::DelegationStarted { base, .. } => base.run_id.as_deref(),
            Self::DelegationSettled { base, .. } => base.run_id.as_deref(),
            Self::Reasoning { base, .. } => base.run_id.as_deref(),
            Self::ToolCall { base, .. } => base.run_id.as_deref(),
            Self::Notice { base, .. } => base.run_id.as_deref(),
            Self::Compaction { base, .. } => base.run_id.as_deref(),
            Self::Unknown { base, .. } => base.run_id.as_deref(),
            Self::Artifact { base, .. } => base.run_id.as_deref(),
        }
    }
}

use crate::delta_text::{
    OutputSummaryData, OutputSummaryView, append_text, output_deltas, summarize_output,
};
use crate::item_input::{ItemIdentity, item_detail_kind, merge_candidate};

/// Resolve native agent references in a draft detail to ace ids.
fn canonical_detail(
    state: &mut ThreadState,
    key: &str,
    draft: &Map,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<Map> {
    let kind = draft.get("kind").and_then(|kind| kind.as_str())?;
    if kind != "agent.spawn" && kind != "agent.message" {
        return Some(draft.clone());
    }
    let (native_key, id_key) = if kind == "agent.spawn" {
        ("childAgent", "childAgentId")
    } else {
        ("targetAgent", "targetAgentId")
    };
    let native = draft.get(native_key).and_then(|value| value.as_str())?;
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
    if let Some(previous) = &previous {
        if previous.agent_id() != record_id {
            return None;
        }
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
    let candidate_text = ace_json::to_string(&Json::Object(candidate));
    let mut item: Item = serde_json::from_str(&candidate_text).ok()?;
    // Legacy output strings become suffix deltas: restore the verified stream
    // first, then append only the new aggregate bytes.
    let legacy = legacy_aggregate(previous.as_ref(), draft, &item);
    if let Some(aggregate) = &legacy {
        if let Item::ToolCall { call, .. } = &mut item {
            if matches!(&call.detail, ToolDetail::Shell { .. }) {
                let prior = match &previous {
                    Some(Item::ToolCall { call, .. }) => match &call.detail {
                        ToolDetail::Shell { output, .. } => output.clone(),
                        _ => None,
                    },
                    _ => None,
                };
                if let ToolDetail::Shell { output, .. } = &mut call.detail {
                    *output = prior;
                }
            }
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
        append_stored_delta(state, key, "output", &suffix, events)?;
    }
    if let Some(Item::ToolCall { call, .. }) = get(&state.items, key) {
        if matches!(&call.detail, ToolDetail::AgentSpawn { .. }) {
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
    }
    get(&state.items, key).cloned()
}

/// The created time of a stored item.
pub(crate) fn item_created_at(item: &Item) -> i64 {
    match item {
        Item::Html { base, .. } => base.created_at,
        Item::Image { base, .. } => base.created_at,
        Item::Message { base, .. } => base.created_at,
        Item::DelegationStarted { base, .. } => base.created_at,
        Item::DelegationSettled { base, .. } => base.created_at,
        Item::Reasoning { base, .. } => base.created_at,
        Item::ToolCall { base, .. } => base.created_at,
        Item::Notice { base, .. } => base.created_at,
        Item::Compaction { base, .. } => base.created_at,
        Item::Unknown { base, .. } => base.created_at,
        Item::Artifact { base, .. } => base.created_at,
    }
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

/// Whether `applyDelta(item, field, append)` would change `item`.
fn delta_changes(item: &Item, field: &str, append: &str) -> bool {
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
fn append_stored_delta(
    state: &mut ThreadState,
    key: &str,
    field: &str,
    append: &str,
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
                    append: part,
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
                append: append.to_owned(),
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
    append: &str,
) -> Option<()> {
    match state.items.get_mut(key)? {
        Item::ToolCall { call, .. } if field == "output" => {
            if let ToolDetail::Shell { output, .. } = &mut call.detail {
                let previous = output.as_ref().map(|summary| OutputSummaryView {
                    stream_id: summary.stream_id.clone(),
                    bytes: summary.bytes,
                    tail: summary.tail.clone(),
                });
                let summary: OutputSummaryData =
                    summarize_output(&call.id, append, previous.as_ref());
                *output = Some(OutputSummary {
                    stream_id: summary.stream_id,
                    bytes: summary.bytes,
                    tail: summary.tail,
                    truncated: summary.truncated,
                });
                return Some(());
            }
            return None;
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
            return Some(());
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
            return Some(());
        }
        Item::Message { parts, .. } if field == "text" => {
            match parts.last_mut() {
                Some(ContentPart::Text { text, source }) => {
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
                _ => parts.push(ContentPart::Text {
                    text: append.to_owned(),
                    source: None,
                }),
            }
            return Some(());
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
    append: &str,
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
    if changed {
        if let Some(record) = state.agents.get_mut(agent_key) {
            record.activity = activity.unwrap_or_default().to_owned();
            record.detail = None;
        }
    }
    let unresponsive = get(&state.agents, agent_key)
        .map(|record| record.agent.status.state() == "unresponsive")
        .unwrap_or(false);
    Some(created || changed || unresponsive)
}
