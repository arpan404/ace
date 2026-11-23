// SPDX-License-Identifier: Apache-2.0
//! `ace-core` as WebAssembly for `fake-daemon` in the browser: a thin
//! `wasm-bindgen` binding with no logic of its own (ADR 0223, decided by the
//! orchestrator). One reducer, two loaders: this crate and the napi addon.
//! State crosses as JSON on every call; the binding only translates.

use std::panic::{AssertUnwindSafe, catch_unwind};

use ace_core::ThreadState;
use wasm_bindgen::prelude::*;

fn failure(message: String) -> JsValue {
    JsValue::from_str(&message)
}

fn parse_state(text: &str) -> Result<ThreadState, String> {
    serde_json::from_str(text).map_err(|error| error.to_string())
}

fn parse_fact(text: &str) -> Result<serde_json::Value, String> {
    ace_core::json_io::parse_untrusted(text).map_err(|error| error.to_string())
}

fn to_millis(now: f64) -> Result<i64, String> {
    if !now.is_finite() || now.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&now) {
        return Err("now must be a nonnegative integer".to_owned());
    }
    Ok(now as i64)
}

struct NextId<'a> {
    next: &'a js_sys::Function,
    failure: Option<String>,
}

impl ace_core::state::IdSource for NextId<'_> {
    fn next(&mut self, kind: &str) -> Option<String> {
        if self.failure.is_some() {
            return None;
        }
        match self.next.call1(&JsValue::NULL, &JsValue::from_str(kind)) {
            Ok(value) => value.as_string(),
            Err(error) => {
                self.failure = Some(
                    error
                        .as_string()
                        .unwrap_or_else(|| "ids.next failed".to_owned()),
                );
                None
            }
        }
    }
}

/// Create a thread state; mirrors `createThreadState`.
#[wasm_bindgen]
pub fn core_create_thread(
    thread_id: &str,
    config_json: &str,
    root_json: Option<String>,
) -> Result<String, JsValue> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        create_inner(thread_id, config_json, root_json.as_deref())
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(failure(error)),
        Err(_) => Err(failure("core thread failed to start".to_owned())),
    }
}

fn create_inner(
    thread_id: &str,
    config_json: &str,
    root_json: Option<&str>,
) -> Result<String, String> {
    let config: ace_core::state::CoreConfig =
        serde_json::from_str(config_json).map_err(|error| error.to_string())?;
    let root = match root_json {
        None => None,
        Some(text) => Some(serde_json::from_str(text).map_err(|error| error.to_string())?),
    };
    let state =
        ace_core::state::create_thread_state(thread_id.to_owned(), root, config).map_err(|error| error.to_string())?;
    serde_json::to_string(&state).map_err(|error| error.to_string())
}

/// Fold one fact, returning events and the refreshed state as JSON.
#[wasm_bindgen]
pub fn core_apply(
    state_json: &str,
    fact_json: &str,
    now: f64,
    next_id: &js_sys::Function,
) -> Result<String, JsValue> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        apply_inner(state_json, fact_json, now, next_id)
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(failure(error)),
        Err(_) => Err(failure("core apply failed".to_owned())),
    }
}

fn apply_inner(
    state_json: &str,
    fact_json: &str,
    now: f64,
    next_id: &js_sys::Function,
) -> Result<String, String> {
    let mut state = parse_state(state_json)?;
    let now = to_millis(now)?;
    let input = parse_fact(fact_json)?;
    let mut ids = NextId {
        next: next_id,
        failure: None,
    };
    let mut ctx = ace_core::state::ApplyContext {
        now,
        ids: &mut ids,
        resolving_interactions: None,
    };
    let mut events = Vec::new();
    let outcome = ace_core::reduce::apply(&mut state, &input, &mut ctx, &mut events);
    if let Some(failure) = ids.failure {
        return Err(failure);
    }
    outcome.ok_or_else(|| "core contract: fold failed".to_owned())?;
    let response = serde_json::json!({ "events": events, "state": state });
    serde_json::to_string(&response).map_err(|error| error.to_string())
}

/// Derive one agent's status from a state snapshot.
#[wasm_bindgen]
pub fn core_derive_agent_status(
    state_json: &str,
    key: &str,
    now: f64,
) -> Result<String, JsValue> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(state_json)?;
        let now = to_millis(now)?;
        let status = ace_core::status::derive_agent_status(&state, key, now);
        serde_json::to_string(&status).map_err(|error| error.to_string())
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(failure(error)),
        Err(_) => Err(failure("core derive failed".to_owned())),
    }
}

/// Derive one thread's status from a state snapshot.
#[wasm_bindgen]
pub fn core_derive_thread_status(state_json: &str) -> Result<String, JsValue> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(state_json)?;
        let status = ace_core::status::derive_thread_status(&state);
        serde_json::to_string(&status).map_err(|error| error.to_string())
    }));
    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(error)) => Err(failure(error)),
        Err(_) => Err(failure("core derive failed".to_owned())),
    }
}

/// The next deadline from a state snapshot.
#[wasm_bindgen]
pub fn core_next_deadline(state_json: &str, provider_deadline: Option<f64>) -> Result<JsValue, JsValue> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state = parse_state(state_json)?;
        let provider = match provider_deadline {
            None => None,
            Some(deadline) => {
                if !deadline.is_finite() || deadline.fract() != 0.0 || deadline < 0.0 {
                    return Err("provider deadline must be a nonnegative integer".to_owned());
                }
                Some(deadline as i64)
            }
        };
        Ok::<Option<i64>, String>(ace_core::deadlines::next_deadline(&state, provider))
    }));
    match result {
        Ok(Ok(deadline)) => Ok(deadline.map(JsValue::from).unwrap_or(JsValue::UNDEFINED)),
        Ok(Err(error)) => Err(failure(error)),
        Err(_) => Err(failure("core deadline failed".to_owned())),
    }
}

/// The crate this binding serves, for smoke checks.
#[wasm_bindgen]
pub fn core_crate_name() -> String {
    "ace-core".to_owned()
}
