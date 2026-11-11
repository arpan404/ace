//! Hand-written mirrors of the few daemon messages Spade sends and reads, with only the fields
//! Spade needs. Unknown fields are ignored and unknown message types skipped, so a newer daemon
//! never breaks Spade. Each type names the Zod schema it mirrors; generated types come later.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Mirrors the `hello` arm of `CoreClientMessage` in `packages/protocol/src/wire-core.ts`, with
/// the local token as its one credential.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub protocol_version: u8,
    pub device_id: &'a str,
    pub token: &'a str,
}

/// Mirrors `SkillsRequest` and the `list` and `read` arms of `SkillOperation` in
/// `packages/protocol/src/skill-library.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsRequest<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: &'a str,
    pub operation: Operation<'a>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(crate) enum Operation<'a> {
    #[serde(rename_all = "camelCase")]
    List {
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<&'a str>,
    },
    #[serde(rename_all = "camelCase")]
    Read {
        id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<&'a str>,
    },
}

/// The server messages Spade reads, by `type`: `welcome` and `error` from `ServerMessage` in
/// `packages/protocol/src/wire-core.ts`, `skills.result` (`SkillsResult`) from
/// `packages/protocol/src/skill-library.ts`. Anything else is `Other`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum Incoming {
    #[serde(rename = "welcome")]
    Welcome,
    #[serde(rename = "error")]
    Error(ErrorFrame),
    #[serde(rename = "skills.result")]
    SkillsResult(SkillsResult),
    #[serde(other)]
    Other,
}

/// Mirrors the `error` arm of `ServerMessage` in `packages/protocol/src/wire-core.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorFrame {
    pub code: String,
    #[serde(default)]
    pub message: String,
    pub request_id: Option<String>,
}

/// Mirrors `SkillsResult` in `packages/protocol/src/skill-library.ts`. `result` stays raw here
/// so a result kind Spade doesn't know still reaches its request as an error, not a parse failure.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsResult {
    pub request_id: String,
    pub result: Value,
}

/// Mirrors the `list`, `skill` and `error` arms of `SkillResult` in
/// `packages/protocol/src/skill-library.ts`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SkillResult {
    List {
        entries: Vec<SkillEntry>,
    },
    Skill {
        entry: SkillEntry,
        text: String,
    },
    Error {
        code: String,
        #[serde(default)]
        message: String,
    },
}

/// Mirrors `SkillEntry` in `packages/protocol/src/skill-library.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillEntry {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    pub scope: String,
    #[serde(default)]
    pub manual: bool,
    pub argument_hint: Option<String>,
    pub hash: String,
}
