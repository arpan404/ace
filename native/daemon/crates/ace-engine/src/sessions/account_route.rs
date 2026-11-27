// SPDX-License-Identifier: Apache-2.0
//! `account-route.ts` (ADR 0018, 2026-10-19 amendment): how a thread continues on another account
//! of the same provider. A native copy keeps the whole session, so it is tried first; when the
//! provider or either login can't be copied, the destination resumes the session it left on this
//! thread with what happened since, or starts fresh with the conversation handoff. Moved cases:
//! `provider-release.process` and the account-switch cases of `model-selection.process`.

use ace_core::state::ThreadState;
use ace_json::Value;
use ace_protocol::generated::{Capabilities, ExecutionSelection};

/// What the route reads from the provider's capabilities (`Capabilities`'s fields, narrowed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouteCapabilities {
    pub resume: bool,
    pub fork: bool,
    /// The native fork boundaries the provider supports: `"end"`, `"turn"`.
    pub fork_points: Vec<String>,
}

impl RouteCapabilities {
    pub fn of(capabilities: &Capabilities) -> RouteCapabilities {
        RouteCapabilities {
            resume: capabilities.resume,
            fork: capabilities.fork,
            fork_points: capabilities
                .fork_points
                .iter()
                .map(|point| point.0.clone())
                .collect(),
        }
    }
}

/// What the accounts service answered for a native copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migration {
    Refused(String),
    Migrated {
        native_session_id: String,
        /// `"fork"` or `"resume"`.
        action: String,
        cleanup_warnings: Vec<String>,
    },
}

/// Where the thread goes next.
#[derive(Debug, Clone, PartialEq)]
pub enum AccountRoute {
    /// Nothing native to carry: the destination opens fresh with any waiting handoff.
    Rebind,
    /// The session was copied into the destination home and resumes there.
    Copied {
        native_session_id: String,
        fork: Option<Value>,
    },
    /// The destination resumes its own earlier session, or opens fresh, with a handoff.
    Handoff { plan: Value },
}

/// One account change, as `routeAccountChange` reads it.
pub struct AccountChange<'a> {
    pub from: &'a ExecutionSelection,
    pub to: &'a ExecutionSelection,
    pub native_session_id: Option<&'a str>,
    pub capabilities: &'a RouteCapabilities,
    pub backend: Option<&'a str>,
    pub budget: f64,
}

/// `routeAccountChange`: try a native copy first, then the provider's own return, then a fresh
/// open with the handoff. A copy the accounts service refuses for safety fails the switch.
pub async fn route_account_change(
    change: &AccountChange<'_>,
    state: &ThreadState,
    migrate: impl FnOnce(&str, &str, &str) -> crate::futures::future::LocalBoxFuture<'static, Migration>,
    plan_cross_provider: impl Fn(&ThreadState, bool, Option<&str>, f64) -> Value,
) -> Result<AccountRoute, String> {
    let Some(native_session_id) = change.native_session_id else {
        return Ok(AccountRoute::Rebind);
    };
    let Some(to_instance) = change.to.instance_id.as_deref() else {
        return Err("Account changes require a destination account".to_owned());
    };
    if let Some(from_instance) = change.from.instance_id.as_deref()
        && change.capabilities.resume
    {
        let migration = migrate(native_session_id, from_instance, to_instance).await;
        match migration {
            Migration::Refused(reason) => return Err(reason),
            Migration::Migrated {
                native_session_id,
                action,
                cleanup_warnings,
            } => {
                if cleanup_warnings
                    .iter()
                    .any(|warning| warning == "lease_release_failed")
                {
                    return Err("Migration lease release failed".to_owned());
                }
                return copied_session(&native_session_id, &action, state, change.capabilities);
            }
        }
    }
    Ok(AccountRoute::Handoff {
        plan: plan_cross_provider(
            state,
            change.capabilities.resume,
            change.backend,
            change.budget,
        ),
    })
}

/// `copiedSession`: a resumed copy needs no boundary; a fork names the one it can make.
fn copied_session(
    native_session_id: &str,
    action: &str,
    state: &ThreadState,
    capabilities: &RouteCapabilities,
) -> Result<AccountRoute, String> {
    let copied = |fork: Option<Value>| AccountRoute::Copied {
        native_session_id: native_session_id.to_owned(),
        fork,
    };
    if action == "resume" {
        return Ok(copied(None));
    }
    if capabilities.fork && capabilities.fork_points.iter().any(|point| point == "end") {
        return Ok(copied(Some(ace_json::json!({
            "nativeSessionId": native_session_id,
            "point": {"type": "end", "nativeId": native_session_id},
        }))));
    }
    let root = state
        .root_key
        .as_ref()
        .and_then(|key| state.agents.get(key));
    let native = root
        .and_then(|root| root.last_run.as_ref())
        .and_then(|run| state.runs.get(run))
        .and_then(|run| run.native_id.clone());
    let turn = capabilities.fork && capabilities.fork_points.iter().any(|point| point == "turn");
    match native {
        Some(native) if turn => Ok(copied(Some(ace_json::json!({
            "nativeSessionId": native_session_id,
            "point": {"type": "turn", "nativeId": native},
        })))),
        _ => Err("Migrated session requires an unsupported native fork boundary".to_owned()),
    }
}

#[cfg(test)]
mod tests;
