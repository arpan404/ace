// SPDX-License-Identifier: Apache-2.0
//! `Error`'s payload, which the binding maps to the TypeScript `ForgeError`. The parts'
//! behaviour has no test until a work item ports it (F1's class (a) files are the proof).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use ace_json::Value;

use crate::error::Error;

fn object<'a>(value: &'a Value, field: &str) -> &'a ace_json::Map {
    value
        .as_object()
        .and_then(|fields| fields.get(field))
        .and_then(Value::as_object)
        .expect("the field is an object")
}

#[test]
fn a_deferral_message_names_the_part_and_the_operation() {
    let error = Error::unimplemented("github", "status");
    assert!(error.is_stub());
    assert_eq!(
        error.to_string(),
        "ace-forge github is not ported yet; deferred to TypeScript (status)"
    );
    let payload = ace_json::parse(&error.to_payload()).expect("the payload is JSON");
    assert_eq!(
        object(&payload, "details").get("op"),
        Some(&Value::from("status"))
    );
}

#[test]
fn an_internal_failure_is_never_a_stub_and_cannot_break_the_payload() {
    let error = Error::Internal(String::from("a \"quoted\" reason"));
    assert!(!error.is_stub());
    let payload = ace_json::parse(&error.to_payload()).expect("the payload is JSON");
    let details = object(&payload, "details");
    assert_eq!(details.get("stub"), Some(&Value::from(false)));
    assert_eq!(
        details.get("message"),
        Some(&Value::from("a \"quoted\" reason"))
    );
}
