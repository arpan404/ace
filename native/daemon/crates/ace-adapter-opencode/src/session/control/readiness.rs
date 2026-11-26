// SPDX-License-Identifier: Apache-2.0
//! The readiness RPC's policy (`packages/adapter-opencode/src/mcp-ready.ts`):
//! OpenCode 2.2.7 activates a location's plugins after the location already
//! answers requests, so the readiness RPC is briefly unavailable on a fresh
//! location. An unavailable RPC is retried with a doubling delay while the
//! budget lasts, then reported unconfirmed; any other failure is real.
//!
//! The wait itself is the engine's (E5.6): this module decides the next step
//! and whether the reply proves ace's native context tool loaded.

use crate::translate::data::{arr_in, fields, s_in};
use ace_json::Value;

/// How long readiness may take overall, including the wait for ace's native tools.
pub const BUDGET_MS: f64 = 10_000.0;
/// The context tool readiness waits for. OpenCode names an MCP tool
/// `<server>_<tool>`, so ace's always-listed `context` tool is `ace_context`.
pub const CONTEXT_TOOL: &str = "ace_context";
/// `ReadyCatalog`'s tool bound.
pub const MAX_TOOLS: usize = 256;

/// What to do after a readiness call failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The RPC is still unregistered: ask again after `in_ms`.
    Retry { in_ms: u64 },
    /// The budget ran out while the RPC was unregistered. ace's tools may or may
    /// not have loaded, and only the plugin can tell.
    Unconfirmed,
    /// A failure that is not a missing plugin: it is real.
    Fail,
}

/// Whether the refused reply is OpenCode's "no plugin registered this method".
fn unavailable(error: &Value) -> bool {
    s_in(fields(error), "type") == "rpc.unavailable"
}

/// `readinessStep(error, elapsedMs, patienceMs)`: a missing plugin retries 100 ms
/// after the first 400 ms, doubling to at most 500 ms, while the delay fits in
/// the patience; anything else fails, and a retry that no longer fits is
/// unconfirmed. With `patienceMs` 0 the first failure is unconfirmed.
pub fn step(error: &Value, elapsed_ms: f64, patience_ms: f64) -> Step {
    if !unavailable(error) {
        return Step::Fail;
    }
    let doubling = (elapsed_ms / 400.0).floor();
    let retry = (100.0 * 2f64.powf(doubling)).min(500.0);
    if elapsed_ms + retry <= patience_ms {
        Step::Retry {
            in_ms: retry as u64,
        }
    } else {
        Step::Unconfirmed
    }
}

/// Why a readiness reply did not prove ace's tools loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReadyError {
    /// The reply parsed, and the context tool is not in it (or has no description,
    /// which is the native catalog's sign that it is registered).
    #[error("OpenCode ace context tool is missing from its native catalog")]
    MissingTool,
    /// The reply is not the catalog the RPC declares.
    #[error("OpenCode readiness reply failed its check")]
    Malformed,
}

/// `ReadyCatalog.parse(reply)` then the context-tool check: `{tools: [{name,
/// description}]}`, at most 256, one of them `ace_context` with a description.
pub fn ready(reply: &Value) -> Result<(), ReadyError> {
    let tools = match fields(reply).get("tools") {
        Some(Value::Array(tools)) if tools.len() <= MAX_TOOLS => tools,
        _ => return Err(ReadyError::Malformed),
    };
    for tool in tools {
        let tool = fields(tool);
        let (Some(Value::String(_)), Some(Value::String(_))) =
            (tool.get("name"), tool.get("description"))
        else {
            return Err(ReadyError::Malformed);
        };
    }
    let found = arr_in(fields(reply), "tools").iter().any(|tool| {
        let tool = fields(tool);
        s_in(tool, "name") == CONTEXT_TOOL && !s_in(tool, "description").is_empty()
    });
    if found {
        Ok(())
    } else {
        Err(ReadyError::MissingTool)
    }
}

#[cfg(test)]
mod tests;
