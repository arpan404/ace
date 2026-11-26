// SPDX-License-Identifier: Apache-2.0
//! The one `z.lazy`-free transform the shape table cannot describe: `ThreadStatus` reads a
//! state this client doesn't know as `{ state: "unknown", raw }`. The JSON Schema is
//! unconstrained there, so the generated table names this pair instead.

use ace_json::{Map, Value};

use crate::shape::{Custom, fits, strip};

/// `ThreadStatus` from `packages/protocol/src/thread-status.ts`.
pub static THREAD_STATUS: Custom = Custom {
    fits: thread_status_fits,
    strip: thread_status_strip,
};

fn thread_status_fits(value: &Value) -> bool {
    let Value::Object(map) = value else {
        return false;
    };
    let Some(Value::String(state)) = map.get("state") else {
        return false;
    };
    let state = state.as_str();
    let length = state.chars().count();
    if is_known_state(state) {
        return fits(&crate::shapes::KNOWN_THREAD_STATUS, value);
    }
    if state == "unknown" {
        return fits(&crate::shapes::KNOWN_THREAD_STATUS, value);
    }
    if length == 0 || length > 64 {
        return false;
    }
    true
}

fn thread_status_strip(value: &Value) -> Option<Value> {
    let Value::Object(map) = value else {
        return Some(value.clone());
    };
    let Some(Value::String(state)) = map.get("state") else {
        return Some(value.clone());
    };
    if is_known_state(state.as_str()) || state.as_str() == "unknown" {
        return Some(strip(&crate::shapes::KNOWN_THREAD_STATUS, value));
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

#[cfg(test)]
mod tests {
    use ace_json::parse;

    use crate::custom::THREAD_STATUS;
    use crate::shape::{Shape, fits, strip};

    fn status() -> Shape {
        Shape::Custom(&THREAD_STATUS)
    }

    #[test]
    fn thread_status_rejects_an_empty_state() {
        assert!(!fits(&status(), &parse(r#"{"state":""}"#).unwrap()));
    }

    #[test]
    fn thread_status_rejects_a_state_longer_than_sixty_four_code_points() {
        let state = "a".repeat(65);
        assert!(!fits(
            &status(),
            &parse(&format!(r#"{{"state":"{state}"}}"#)).unwrap()
        ));
    }

    #[test]
    fn thread_status_unknown_strips_extra_keys() {
        let text = r#"{"state":"unknown","raw":{},"extra":1}"#;
        let stripped = strip(&status(), &parse(text).unwrap());
        assert_eq!(
            ace_json::to_string(&stripped),
            r#"{"state":"unknown","raw":{}}"#
        );
    }

    #[test]
    fn thread_status_known_unknown_raw_must_fit_its_schema() {
        assert!(!fits(
            &status(),
            &parse(r#"{"state":"unknown","raw":"nope"}"#).unwrap()
        ));
    }
}
