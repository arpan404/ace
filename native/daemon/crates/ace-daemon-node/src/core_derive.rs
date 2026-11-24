// SPDX-License-Identifier: Apache-2.0
//! The core's stateless answers over a state snapshot: statuses, deadlines and the two rules
//! the protocol shares. They translate handles and errors only; behaviour lives in `ace-core`.

// napi-derive registers this module's exports only outside test builds, so in
// the lib test target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi_derive::napi;

use crate::core::{CoreBindError, parse_state, to_millis};

/// Derive one agent's status from a state snapshot.
#[napi(catch_unwind)]
pub fn core_derive_agent_status(state_json: String, key: String, now: f64) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let now = to_millis(now)?;
        let state = parse_state(&state_json)?;
        let status = ace_core::status::derive_agent_status(&state, &key, now);
        ace_json::ser::to_string(&status)
            .map_err(|error| CoreBindError::Contract(error.to_string()))
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core derive panicked")),
    }
}

/// Derive one thread's status from a state snapshot.
#[napi(catch_unwind)]
pub fn core_derive_thread_status(state_json: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(&state_json)?;
        let status = ace_core::status::derive_thread_status(&state);
        ace_json::ser::to_string(&status)
            .map_err(|error| CoreBindError::Contract(error.to_string()))
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core derive panicked")),
    }
}

/// The next deadline from a state snapshot.
#[napi(catch_unwind)]
pub fn core_next_deadline(
    state_json: String,
    provider_deadline: Option<f64>,
) -> napi::Result<Option<f64>> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(&state_json)?;
        // Invalid provider deadlines are ignored, like TypeScript's
        // `earliest` (safe integer >= 0), not rejected.
        let provider = match provider_deadline {
            Some(deadline)
                if deadline.is_finite()
                    && deadline.fract() == 0.0
                    && (0.0..=9_007_199_254_740_991.0).contains(&deadline) =>
            {
                Some(deadline as i64)
            }
            _ => None,
        };
        Ok::<Option<i64>, CoreBindError>(ace_core::deadlines::next_deadline(&state, provider))
    }));
    match result {
        Ok(Ok(deadline)) => Ok(deadline.map(|deadline| deadline as f64)),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core deadline panicked")),
    }
}

/// One deadline index behind a handle the TypeScript shell holds.
#[napi]
pub struct DeadlineIndexNative {
    inner: ace_core::deadlines::DeadlineIndex,
}

#[napi]
impl DeadlineIndexNative {
    /// Build the index over one state snapshot.
    #[napi(constructor, catch_unwind)]
    pub fn new(state_json: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            parse_state(&state_json).map(|state| Self {
                inner: ace_core::deadlines::DeadlineIndex::new(&state),
            })
        }));
        match result {
            Ok(Ok(index)) => Ok(index),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("deadline index failed to start")),
        }
    }

    /// Rebuild the index over one state snapshot.
    #[napi(catch_unwind)]
    pub fn rebuild(&mut self, state_json: String) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| parse_state(&state_json)));
        match result {
            Ok(Ok(state)) => {
                self.inner.rebuild(&state);
                Ok(())
            }
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("deadline index failed to rebuild")),
        }
    }

    /// Move eligibility after a signal.
    #[napi(catch_unwind)]
    pub fn signal(&mut self, agent: Option<String>, at: f64, silence_ms: f64) -> napi::Result<()> {
        if !at.is_finite() || !silence_ms.is_finite() || silence_ms < 0.0 {
            return Err(napi::Error::from_reason(
                "deadline signal needs finite times",
            ));
        }
        let result = catch_unwind(AssertUnwindSafe(|| {
            self.inner.signal(agent.as_deref(), at as i64, silence_ms);
        }));
        match result {
            Ok(()) => Ok(()),
            Err(_) => Err(napi::Error::from_reason("deadline signal panicked")),
        }
    }

    /// The earliest deadline, if any.
    #[napi(catch_unwind)]
    pub fn next(&mut self, provider_deadline: Option<f64>) -> napi::Result<Option<f64>> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let provider = match provider_deadline {
                Some(deadline)
                    if deadline.is_finite()
                        && deadline.fract() == 0.0
                        && (0.0..=9_007_199_254_740_991.0).contains(&deadline) =>
                {
                    Some(deadline as i64)
                }
                _ => None,
            };
            Ok::<Option<i64>, CoreBindError>(self.inner.next(provider))
        }));
        match result {
            Ok(Ok(deadline)) => Ok(deadline.map(|deadline| deadline as f64)),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(napi::Error::from_reason("deadline next panicked")),
        }
    }
}

/// Whether an agent still counts for completion, from a state snapshot.
#[napi(catch_unwind)]
pub fn core_completion_relevant(state_json: String, key: String) -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(&state_json)?;
        Ok::<bool, CoreBindError>(ace_core::status::completion_relevance_reader(&state)(&key))
    }));
    match result {
        Ok(Ok(relevant)) => Ok(relevant),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core relevance panicked")),
    }
}

/// The human-attention rule, from interaction and owner snapshots.
#[napi(catch_unwind)]
pub fn core_is_actionable_interaction(
    interaction_json: String,
    owner_json: Option<String>,
) -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let interaction = ace_core::json_io::parse_untrusted(&interaction_json)
            .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
        let state = interaction
            .get("state")
            .and_then(|state| state.as_str())
            .unwrap_or("");
        let blocking = interaction
            .get("blocking")
            .and_then(|blocking| blocking.as_bool())
            .unwrap_or(false);
        let owner_state = match owner_json.as_deref() {
            None => None,
            Some(text) => {
                let owner = ace_core::json_io::parse_untrusted(text)
                    .map_err(|error| CoreBindError::InvalidContext(error.to_string()))?;
                owner
                    .get("state")
                    .and_then(|state| state.as_str())
                    .map(str::to_owned)
            }
        };
        Ok::<bool, CoreBindError>(ace_core::human::is_actionable_interaction(
            state,
            blocking,
            owner_state.as_deref(),
        ))
    }));
    match result {
        Ok(Ok(actionable)) => Ok(actionable),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(napi::Error::from_reason("core interaction rule panicked")),
    }
}
