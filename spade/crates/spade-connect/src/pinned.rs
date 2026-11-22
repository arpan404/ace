//! What a connected app's call was approved as, checked on the session that sends it (ADR 0202,
//! amendment 5). The gate decides a call on the tool's definition as listed then (its name,
//! description and input schema) and on the session it was listed by. Between that decision and
//! the send, a relist or a renewed sign-in may change what the server offers under the same name,
//! so right before each send the sending session must still list the tool with that definition,
//! and still be the session (its generation) the decision was made on, or the call isn't sent.
//! A renewal this very call makes to send it keeps the generation it was decided on, since it
//! never ran before; the definition is checked again on the renewed session.
//!
//! A digest is what the server claims about the tool, never proof of what it does.

use sha2::{Digest, Sha256};
use spade_mcp::McpTool;

use crate::{CallError, Connectors};

/// A digest of `tool`'s definition as its server lists it: its own name, description and input
/// schema.
pub fn definition(tool: &McpTool) -> String {
    let text = serde_json::json!([tool.name, tool.description, tool.input_schema]).to_string();
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// What a call was approved as: the tool's definition and the session's generation then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expect {
    pub definition: String,
    pub generation: u64,
}

impl Connectors {
    /// The generation of `connector`'s session now: it changes whenever its client is replaced
    /// (a renewed sign-in, a restarted session).
    pub fn generation(&self, connector: &str) -> u64 {
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        live.get(connector).map_or(0, |session| session.generation)
    }

    /// Whether `connector`'s session still lists `tool` with the definition `expect` names.
    pub(crate) fn still_listed(&self, connector: &str, tool: &str, expect: &Expect) -> bool {
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        live.get(connector).is_some_and(|session| {
            session
                .tools
                .iter()
                .any(|listed| listed.name == tool && definition(listed) == expect.definition)
        })
    }

    /// Why a call approved as `expect` isn't sent on `connector`'s session as it is now, if it
    /// isn't.
    pub(crate) fn unlike(
        &self,
        connector: &str,
        name: &str,
        tool: &str,
        expect: &Expect,
        generation: u64,
    ) -> Option<CallError> {
        if generation != expect.generation {
            return Some(CallError::NotRun(format!(
                "{name}'s session changed since this call was approved, so it wasn't sent"
            )));
        }
        (!self.still_listed(connector, tool, expect)).then(|| {
            CallError::NotRun(format!(
                "{name} changed this tool since the call was approved, so it wasn't sent"
            ))
        })
    }
}
