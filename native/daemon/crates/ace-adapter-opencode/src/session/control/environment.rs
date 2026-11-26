// SPDX-License-Identifier: Apache-2.0
//! The shell-environment gate (`agent-env.ts`, `session.ts:278`-`:308`): the
//! variables one session's shell commands run with, the `PUT` that sets them,
//! and the settle verdict that lets the plugin's tools run or refuses them.
//!
//! An OpenCode server serves many sessions and starts before any thread exists,
//! so the thread's variables are set per session, never in the process. The
//! server never holds a credential an agent's shell could inherit: ace starts it
//! without its own secrets, and the gate holds every tool until ace says the
//! environment is set.

use ace_json::{Map, Value, json};
use indexmap::IndexMap;

use super::Request;
use super::readiness::{self, Step};
use crate::session::api;

/// Credentials no agent's shell ever needs: OpenCode's server's own, and ace's
/// (`agent-env.ts:28`-`:39`). This is the one list: the owned server removes the
/// `ACE_` names from it too (`agent-env.ts:42`-`:46`'s `withoutAceSecrets`).
pub const WITHHELD: [&str; 10] = [
    "OPENCODE_PASSWORD",
    "OPENCODE_SERVER_PASSWORD",
    "ACE_MCP_BEARER_TOKEN",
    "ACE_MCP_TOKEN",
    "ACE_DAEMON_TOKEN",
    "ACE_DAEMON_TOKEN_FILE",
    "ACE_MARKET_SIGNER_TOKEN",
    "ACE_GRANT_KEY",
    "ACE_GRANT_PREVIOUS_KEY",
    "ACE_ACCOUNT_ENCRYPTION_KEY",
];

/// How long the client retries a settle whose plugin is not activated yet
/// (`aceToolsReadyBudgetMs`, `agent-env.ts:78,88`). The plugin's own 30 s tool
/// gate (`environmentGateMs`, `agent-env-contract.ts:31`) is the server's, not
/// this side's: ace gives up at ten seconds and says the gate never registered.
pub const SETTLE_BUDGET_MS: f64 = 10_000.0;
/// The settle verdict's message bound (`agent-env-contract.ts`), in UTF-16 units.
pub const MESSAGE_MAX_UTF16: usize = 1024;

/// `sessionShellEnvironment`: what the server process inherited, without any
/// credential, then the thread's variables, which win over an inherited name.
pub fn session_shell_environment(inherited: &Map, agent_env: &Map) -> Value {
    let mut variables: IndexMap<String, Value> = IndexMap::new();
    for (name, value) in inherited.iter() {
        if WITHHELD.contains(&name.as_str()) {
            continue;
        }
        variables.insert(name.as_str().to_owned(), value.clone());
    }
    for (name, value) in agent_env.iter() {
        variables.insert(name.as_str().to_owned(), value.clone());
    }
    Value::Object(variables.into_iter().collect::<Map>())
}

/// `session.environment` then its settle: the two requests that give a session
/// its thread's shell. Empty when the session has no environment to set.
pub fn apply(
    shell_environment: Option<&Value>,
    session_id: &str,
    directory: &str,
) -> Result<Vec<Request>, api::ApiError> {
    let Some(environment) = shell_environment.filter(|value| matches!(value, Value::Object(_)))
    else {
        return Ok(Vec::new());
    };
    let environment = api::call(
        "session.environment",
        &json!({ "sessionID": session_id, "variables": environment }),
    )?;
    let settled = api::call(
        "agent.environment.settle",
        &json!({
            "location": { "directory": directory },
            "input": { "sessionID": session_id, "ok": true },
        }),
    )?;
    Ok(vec![
        Request::new(directory, environment),
        Request::new(directory, settled),
    ])
}

/// The verdict for a session whose environment could not be set: the gate
/// refuses its tools, with the reason cut to the contract's bound.
pub fn refusal(session_id: &str, directory: &str, reason: &str) -> Result<Request, api::ApiError> {
    Ok(Request::new(
        directory,
        api::call(
            "agent.environment.settle",
            &json!({
                "location": { "directory": directory },
                "input": {
                    "sessionID": session_id,
                    "ok": false,
                    "message": Value::String(truncate_utf16(reason, MESSAGE_MAX_UTF16)),
                },
            }),
        )?,
    ))
}

/// `readinessStep` over the settle call: the gate's plugin is activated per
/// location, so a missing method is retried; anything else, or running out of
/// time, fails. `None` settles, `Some(step)` names what to do next.
pub fn settle_step(error: &Value, elapsed_ms: f64) -> Step {
    readiness::step(error, elapsed_ms, SETTLE_BUDGET_MS)
}

/// `reason.slice(0, units)`: a cut in UTF-16 units that may split a surrogate
/// pair, exactly as `String.prototype.slice` does, so the refusal the plugin
/// receives is the same one the TypeScript sends.
fn truncate_utf16(text: &str, units: usize) -> ace_json::JsString {
    ace_json::JsString::from(text).slice_units(0, units)
}

#[cfg(test)]
mod tests;
