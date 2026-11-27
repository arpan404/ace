// SPDX-License-Identifier: Apache-2.0
//! `ThreadStatus`: a state this client doesn't know reads as `{ state: "unknown", raw }`
//! (`packages/protocol/src/thread-status.ts`). `KnownThreadStatus` is the generated table; this
//! pair adds the fallback branch and keeps Zod's order: the known union first (so an `unknown`
//! status with a `raw` object is stripped like the strict object it is), then the loose fallback
//! for a state neither union knows.

use ace_json::{Map, Value};

use crate::shape::{Custom, strip};

/// `ThreadStatus` from `packages/protocol/src/thread-status.ts`.
pub static THREAD_STATUS: Custom = Custom {
    fits: thread_status_fits,
    strip: thread_status_strip,
};

fn thread_status_fits(value: &Value) -> bool {
    matches_known(value) || matches_fallback(value)
}

fn thread_status_strip(value: &Value) -> Option<Value> {
    if matches_known(value) {
        return Some(strip(&crate::shapes::KNOWN_THREAD_STATUS, value));
    }
    if !matches_fallback(value) {
        return Some(value.clone());
    }
    let mut out = Map::with_capacity(2);
    out.insert("state", Value::String(ace_json::JsString::from("unknown")));
    out.insert("raw", value.clone());
    Some(Value::Object(out))
}

/// `KnownThreadStatus`, whose `unknown` branch has its own `raw` shape.
fn matches_known(value: &Value) -> bool {
    crate::shape::fits(&crate::shapes::KNOWN_THREAD_STATUS, value)
}

/// The fallback loose object: a state of 1 to 64 code points that is not one this build knows,
/// with any other keys kept in `raw`.
fn matches_fallback(value: &Value) -> bool {
    let Value::Object(map) = value else {
        return false;
    };
    let Some(Value::String(state)) = map.get("state") else {
        return false;
    };
    let length = state.len_code_points();
    (1..=64).contains(&length) && !is_known_state(state.as_str())
}

/// The states `KnownThreadStatus` fixes, `unknown` included: the fallback excludes them all.
fn is_known_state(state: &str) -> bool {
    matches!(
        state,
        "needs_you"
            | "working"
            | "waiting"
            | "limited"
            | "failed"
            | "unresponsive"
            | "moved"
            | "done"
            | "new"
            | "unknown"
    )
}
