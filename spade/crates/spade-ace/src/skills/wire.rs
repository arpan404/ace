//! Hand-written mirrors of the few daemon messages Spade sends and reads, with only the fields
//! Spade needs. Each type names the Zod schema it mirrors; generated types come later. Unknown
//! message types are skipped, and every skill entry keeps its raw JSON beside what is read.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use spade_mcp::Secret;

/// Mirrors the `hello` arm of `CoreClientMessage` in `packages/protocol/src/wire-core.ts`, with
/// the local token as its one credential. Its `Debug` never shows the token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u8,
    device_id: &'a str,
    token: &'a str,
}

impl<'a> Hello<'a> {
    pub(crate) fn new(device_id: &'a str, token: &'a Secret) -> Self {
        Self {
            kind: "hello",
            protocol_version: 1,
            device_id,
            token: token.expose(),
        }
    }
}

impl fmt::Debug for Hello<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Hello")
            .field("protocol_version", &self.protocol_version)
            .field("device_id", &self.device_id)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// Mirrors `SkillsRequest` and the `list`, `read`, `create` and `edit` arms of `SkillOperation` in
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
    /// A personal skill, linked for `agents`.
    Create {
        name: &'a str,
        description: &'a str,
        body: &'a str,
        scope: PersonalScope,
        agents: &'a [&'a str],
        manual: bool,
    },
    #[serde(rename_all = "camelCase")]
    Edit {
        id: &'a str,
        expected_hash: &'a str,
        description: &'a str,
        body: &'a str,
        manual: bool,
    },
}

impl Operation<'_> {
    /// Only reads may be sent again after a dropped socket.
    pub(crate) fn reads_only(&self) -> bool {
        matches!(self, Self::List { .. } | Self::Read { .. })
    }
}

/// The `personal` arm of the create scope: `{"kind": "personal"}`.
#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct PersonalScope {
    pub kind: &'static str,
}

pub(crate) const PERSONAL: PersonalScope = PersonalScope { kind: "personal" };

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
    /// `spade.machines.result` and `spade.remote.result` from
    /// `packages/protocol/src/spade-remote.ts`, kept whole.
    #[serde(rename = "spade.machines.result", alias = "spade.remote.result")]
    SpadeResult(SpadeResult),
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

/// The answer to a `spade.machines` or `spade.remote` request, its other fields kept raw.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpadeResult {
    pub request_id: String,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}

/// Mirrors `SkillsResult` in `packages/protocol/src/skill-library.ts`. `result` stays raw, so a
/// result kind Spade doesn't know still reaches its request whole.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillsResult {
    pub request_id: String,
    pub result: Value,
}

/// Mirrors the fields Spade reads of `SkillEntry` in `packages/protocol/src/skill-library.ts`.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hello_debug_never_shows_the_token_but_the_frame_carries_it() {
        let token = Secret::new("local-token-value");
        let hello = Hello::new("spade", &token);
        assert!(!format!("{hello:?}").contains("local-token-value"));
        let frame = serde_json::to_string(&hello).unwrap_or_default();
        assert!(frame.contains("\"token\":\"local-token-value\""));
    }
}
