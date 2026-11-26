// SPDX-License-Identifier: Apache-2.0
//! The one `z.lazy`-free transform the shape table cannot describe: `ThreadStatus` reads a
//! state this client doesn't know as `{ state: "unknown", raw }`. The JSON Schema is
//! unconstrained there, so the generated table names this pair instead.

use ace_json::{Map, Value};

use crate::shape::{Custom, strip};

/// `ThreadStatus` from `packages/protocol/src/thread-status.ts`.
pub static THREAD_STATUS: Custom = Custom {
    fits: thread_status_fits,
    strip: thread_status_strip,
};

fn thread_status_fits(value: &Value) -> bool {
    let Value::Object(map) = value else {
        return false;
    };
    matches!(map.get("state"), Some(Value::String(_)))
}

fn thread_status_strip(value: &Value) -> Option<Value> {
    let Value::Object(map) = value else {
        return Some(value.clone());
    };
    let Some(Value::String(state)) = map.get("state") else {
        return Some(value.clone());
    };
    if is_known_state(state.as_str()) {
        return Some(strip(&crate::shapes::KNOWN_THREAD_STATUS, value));
    }
    // An `unknown` status with its `raw` is Zod's own output already (a typed producer wrote
    // it); stripping it again would wrap it twice.
    if state.as_str() == "unknown" && map.get("raw").is_some() {
        return Some(value.clone());
    }
    let mut out = Map::with_capacity(2);
    out.insert("state", Value::String(ace_json::JsString::from("unknown")));
    out.insert("raw", value.clone());
    Some(Value::Object(out))
}

/// The states `KnownThreadStatus` defines; any other is `unknown`.
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
    )
}
