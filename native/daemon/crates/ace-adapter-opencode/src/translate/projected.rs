// SPDX-License-Identifier: Apache-2.0
//! Text, reasoning, and projected history (`native-content.ts`). Deltas
//! stream into items; snapshots reconcile them.

use crate::translate::content::ItemReconciled;
use crate::translate::data::{RawPayload, arr_in, fields, get, n_in, num_str, raw, s_in};
use crate::translate::state::{NativeState, Out, StateError};
use crate::translate::tool::tool;
use serde::Serialize;
use ace_json::{Map, Value};

/// Where a text or reasoning block lives: its session and message.
pub struct TextLoc<'a> {
    pub session: &'a str,
    pub message: &'a str,
    pub ordinal: f64,
}

/// A text or reasoning block: deltas stream, the rest reconciles.
pub fn text(
    state: &mut NativeState,
    typ: &str,
    loc: &TextLoc<'_>,
    p: &Map,
    evidence: &Value,
    out: &mut Out<'_>,
) -> Result<(), StateError> {
    let agent = state.key(loc.session).to_owned();
    let reasoning = typ.contains("reasoning");
    let item = format!(
        "{}:{}:{}:{}",
        if reasoning { "reasoning" } else { "text" },
        loc.session,
        loc.message,
        num_str(loc.ordinal)
    );
    if typ.ends_with("delta") {
        out.fact(&ItemDelta {
            typ: "item.delta",
            agent: &agent,
            item,
            field: if reasoning { "reasoning" } else { "text" },
            append: s_in(p, "delta"),
        })?;
        return Ok(());
    }
    let complete = typ.ends_with("ended");
    if reasoning {
        out.fact(&ItemReconciled {
            typ: "item.reconciled",
            agent: &agent,
            item,
            draft: ReasoningDraft {
                typ: "reasoning",
                text: s_in(p, "text"),
                summary: false,
                complete,
                raw: vec![raw(typ, evidence, None)],
            },
        })?;
    } else {
        out.fact(&ItemReconciled {
            typ: "item.reconciled",
            agent: &agent,
            item,
            draft: StreamedMessageDraft {
                typ: "message",
                role: "assistant",
                parts: vec![TextPart {
                    typ: "text",
                    text: s_in(p, "text"),
                }],
                complete,
                raw: vec![raw(typ, evidence, None)],
            },
        })?;
    }
    Ok(())
}

#[derive(Serialize)]
struct ItemDelta<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    item: String,
    field: &'static str,
    append: &'a str,
}

#[derive(Serialize)]
struct TextPart<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    text: &'a str,
}

#[derive(Serialize)]
struct ReasoningDraft<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    text: &'a str,
    summary: bool,
    complete: bool,
    raw: Vec<RawPayload<'a>>,
}

#[derive(Serialize)]
struct MessageDraft<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    #[serde(skip_serializing_if = "Option::is_none", rename = "nativeId")]
    native_id: Option<&'a str>,
    role: &'static str,
    synthetic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<MessageOrigin<'a>>,
    parts: Vec<TextPart<'a>>,
    complete: bool,
    raw: Vec<RawPayload<'a>>,
}

/// A streamed text message: no identity, no synthetic marker.
#[derive(Serialize)]
struct StreamedMessageDraft<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    role: &'static str,
    parts: Vec<TextPart<'a>>,
    complete: bool,
    raw: Vec<RawPayload<'a>>,
}

#[derive(Serialize)]
struct MessageOrigin<'a> {
    kind: &'a str,
}

/// What a synthetic message reports, read from its native metadata.
pub fn synthetic_kind(metadata: &Map) -> Option<&'static str> {
    match s_in(metadata, "source") {
        "shell" => Some("background_completion"),
        "subagent" => Some("subagent_result"),
        _ => None,
    }
}

/// Project a history snapshot's message into the transcript.
pub fn projected(
    state: &mut NativeState,
    session: &str,
    value: &Value,
    out: &mut Out<'_>,
) -> Result<(), StateError> {
    let p = fields(value);
    let message = s_in(p, "id").to_owned();
    let agent = state.key(session).to_owned();
    if s_in(p, "type") == "assistant" {
        let mut text_ordinal = 0.0;
        let mut reasoning_ordinal = 0.0;
        let blocks: Vec<Value> = arr_in(p, "content").to_vec();
        for block in &blocks {
            let c = fields(block);
            let block_type = s_in(c, "type");
            let ordinal = if block_type == "text" {
                let ordinal = text_ordinal;
                text_ordinal += 1.0;
                ordinal
            } else if block_type == "reasoning" {
                let ordinal = reasoning_ordinal;
                reasoning_ordinal += 1.0;
                ordinal
            } else {
                0.0
            };
            if block_type == "tool" {
                tool(state, "snapshot.tool", session, &message, c, block, out)?;
            } else if block_type == "text" || block_type == "reasoning" {
                let completed =
                    matches!(get(fields(get(c, "time")), "completed"), Value::Number(_));
                let typ = format!(
                    "session.{block_type}.{}",
                    if completed { "ended" } else { "started" }
                );
                text(
                    state,
                    &typ,
                    &TextLoc {
                        session,
                        message: &message,
                        ordinal,
                    },
                    c,
                    block,
                    out,
                )?;
            }
        }
        return Ok(());
    }
    if s_in(p, "type") == "system" {
        return Ok(());
    }
    if s_in(p, "type") == "user" || s_in(p, "type") == "synthetic" {
        let is_synthetic = s_in(p, "type") == "synthetic";
        let kind = if is_synthetic {
            synthetic_kind(fields(get(p, "metadata")))
        } else {
            None
        };
        if is_synthetic {
            state.completion(
                fields(get(p, "metadata")),
                n_in(fields(get(p, "time")), "created"),
                out,
            )?;
        }
        let role = if !is_synthetic || kind.is_some() {
            "user"
        } else {
            "assistant"
        };
        let native_id = if !message.is_empty() && message.encode_utf16().count() <= 256 {
            Some(message.as_str())
        } else {
            None
        };
        out.fact(&ItemReconciled {
            typ: "item.reconciled",
            agent: &agent,
            item: format!("message:{session}:{message}"),
            draft: MessageDraft {
                typ: "message",
                role,
                parts: vec![TextPart {
                    typ: "text",
                    text: s_in(p, "text"),
                }],
                complete: true,
                native_id,
                synthetic: Some(is_synthetic),
                origin: kind.map(|kind| MessageOrigin { kind }),
                raw: vec![raw("projected.message", value, None)],
            },
        })?;
        return Ok(());
    }
    Ok(())
}
