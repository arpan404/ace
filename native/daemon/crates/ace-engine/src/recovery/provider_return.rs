// SPDX-License-Identifier: Apache-2.0
//! What a cross-provider switch hands over (`provider-return.ts`, ADR 0051's 2026-10-19
//! amendment): a provider this thread has not run on gets the conversation-first excerpt; a
//! provider returning to the thread resumes the native session it left, which already holds
//! everything up to then, so it gets only what happened since. Should that session be gone when
//! it opens, the full excerpt goes to a fresh session instead.
//!
//! The excerpts themselves are E5.9's handoff (`@ace/handoff`): this module is the plan over them,
//! so no second copy of the selection or rendering lives here.

use ace_json::Value;

/// A provider's own earlier session this thread ran on (`LeftSession`): the destination resumes it
/// on its next open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeftSession {
    pub provider: String,
    pub instance_id: Option<String>,
    pub backend: String,
    /// The sequence the session already holds; the delta starts after it.
    pub through_seq: i64,
    pub native_session_id: String,
}

/// What a switch hands the destination (`CrossProviderPlan`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrossProviderPlan {
    /// The provider's own earlier session, resumed on its next open.
    pub resume: Option<LeftSession>,
    /// What goes in front of the next message; none when the resumed session already knows all.
    pub handoff: Option<Value>,
    /// The full handoff, for a fresh session if `resume` turns out to be gone.
    pub fallback: Option<Value>,
}

/// `planCrossProvider` (`provider-return.ts:25`): a remembered session is resumed only on the same
/// backend it was left on. `full` is the handoff through the head, `delta` its excerpt since the
/// left session's `throughSeq`.
pub fn plan_cross_provider(
    full: &Value,
    left: Option<LeftSession>,
    backend: Option<&str>,
    delta: Option<&Value>,
) -> CrossProviderPlan {
    let left = left.filter(|left| Some(left.backend.as_str()) == backend);
    let Some(left) = left else {
        return CrossProviderPlan {
            handoff: Some(full.clone()),
            ..CrossProviderPlan::default()
        };
    };
    let happened = delta.is_some_and(|delta| {
        delta
            .get("excerpts")
            .and_then(Value::as_array)
            .is_some_and(|excerpts| !excerpts.is_empty())
            || delta
                .get("omittedItems")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                > 0
    });
    CrossProviderPlan {
        resume: Some(left),
        handoff: happened.then(|| delta.cloned().unwrap_or(Value::Null)),
        fallback: Some(full.clone()),
    }
}

/// True when a resumed session could not be opened because the provider no longer has it
/// (`abandonReturn`'s guard, `:62`): only then is the thread handed to a fresh session; any other
/// failure stays the caller's.
pub fn should_abandon_return(has_fallback: bool, resume_unavailable: bool) -> bool {
    has_fallback && resume_unavailable
}

#[cfg(test)]
mod tests;
