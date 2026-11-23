// SPDX-License-Identifier: Apache-2.0
//! Fact shapes field-for-field with the TypeScript emits.

use super::dialogs::DialogRequest;
use super::tools::ToolDetail;
use ace_core::Fact;
use serde::Serialize;
use ace_json::Raw;

#[derive(Serialize)]
pub struct RawPayload<'a> {
    #[serde(rename = "type")]
    pub payload_type: String,
    pub data: &'a Raw,
}

pub fn raw_payload<'a>(data: &'a Raw, default: &str) -> RawPayload<'a> {
    let payload_type = super::native::raw_type_of(data, default);
    RawPayload { payload_type, data }
}

pub fn make_fact<T: Serialize + ?Sized>(fact_type: &str, value: &T) -> Option<Fact> {
    let data = ace_json::ser::to_raw(value).ok()?;
    Some(Fact {
        fact_type: fact_type.to_owned(),
        data,
    })
}

pub fn push_fact<T: Serialize + ?Sized>(out: &mut Vec<Fact>, fact_type: &str, value: &T) {
    if let Some(fact) = make_fact(fact_type, value) {
        out.push(fact);
    }
}

pub fn raw_json(payload_type: &str, data: &Raw) -> Option<String> {
    let payload = RawPayload {
        payload_type: payload_type.to_owned(),
        data,
    };
    ace_json::ser::to_string(&payload).ok()
}

#[derive(Serialize)]
pub struct TypeOnly {
    #[serde(rename = "type")]
    pub fact_type: String,
}

#[derive(Serialize)]
pub struct AgentOnly {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
}

#[derive(Serialize)]
pub struct NoticeDraft<'a> {
    #[serde(rename = "type")]
    pub draft_type: String,
    pub complete: bool,
    pub text: String,
    pub level: String,
    pub raw: Vec<RawPayload<'a>>,
}

#[derive(Serialize)]
pub struct ItemUpsertNotice<'a> {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub item: String,
    pub draft: NoticeDraft<'a>,
}

#[derive(Serialize)]
pub struct TurnStarted {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    #[serde(rename = "nativeTurnId")]
    pub native_turn_id: String,
    pub trigger: String,
}

#[derive(Serialize)]
pub struct TurnEnded {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    #[serde(rename = "nativeTurnId")]
    pub native_turn_id: String,
    pub outcome: String,
}

#[derive(Serialize)]
pub struct ProcessExited {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub deliberate: bool,
    pub message: String,
}

#[derive(Serialize)]
pub struct InteractionClosed {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub interaction: String,
    pub state: String,
}

#[derive(Serialize)]
pub struct InteractionOpened<'a> {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub interaction: String,
    pub blocking: bool,
    pub request: DialogRequest,
    pub raw: Vec<RawPayload<'a>>,
}

#[derive(Serialize)]
pub struct ItemDelta {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub item: String,
    pub field: String,
    pub append: String,
}

#[derive(Serialize)]
pub struct BackgroundStarted {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub task: String,
    pub item: String,
    pub kind: String,
    pub title: String,
    pub stoppable: bool,
}

#[derive(Serialize)]
pub struct BackgroundEnded {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub task: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct QueueChanged {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub source: String,
    pub count: usize,
}

#[derive(Serialize)]
pub struct Activity {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub activity: String,
}

#[derive(Serialize)]
pub struct Retry {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub on: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<i64>,
}

#[derive(Serialize)]
pub struct ContextSampleFact {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    #[serde(rename = "usedTokens")]
    pub used_tokens: u64,
    #[serde(rename = "windowTokens")]
    pub window_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Serialize)]
pub struct NativeIdDraft {
    #[serde(rename = "type")]
    pub draft_type: String,
    #[serde(rename = "nativeId")]
    pub native_id: String,
}

#[derive(Serialize)]
pub struct NativeIdUpsert {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub item: String,
    pub draft: NativeIdDraft,
}

#[derive(Serialize)]
pub struct ToolCallStart<'a> {
    pub kind: String,
    pub title: String,
    pub status: String,
    pub detail: ToolDetail,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    pub raw: Vec<RawPayload<'a>>,
}

#[derive(Serialize)]
pub struct ToolDraftStart<'a> {
    #[serde(rename = "type")]
    pub draft_type: String,
    pub complete: bool,
    pub call: ToolCallStart<'a>,
}

#[derive(Serialize)]
pub struct ToolUpsertStart<'a> {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub item: String,
    pub draft: ToolDraftStart<'a>,
}

#[derive(Serialize)]
pub struct ToolCallEnd<'a> {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<ToolDetail>,
    #[serde(rename = "endedAt")]
    pub ended_at: i64,
    pub raw: Vec<RawPayload<'a>>,
}

#[derive(Serialize)]
pub struct ToolDraftEnd<'a> {
    #[serde(rename = "type")]
    pub draft_type: String,
    pub complete: bool,
    pub call: ToolCallEnd<'a>,
}

#[derive(Serialize)]
pub struct ToolUpsertEnd<'a> {
    #[serde(rename = "type")]
    pub fact_type: String,
    pub agent: String,
    pub item: String,
    pub draft: ToolDraftEnd<'a>,
}
