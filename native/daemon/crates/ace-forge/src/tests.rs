// SPDX-License-Identifier: Apache-2.0
//! F0's proof: every part the porting guide's table names declares its module, and every
//! probe defers to TypeScript as a stub the shell can recognise and count, never as a
//! failure. Each work item replaces its part's probe with the port.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use ace_json::Value;

use crate::error::Error;

type Probe = fn(&str) -> Result<String, Error>;

fn parts() -> [(&'static str, Probe); 8] {
    [
        ("transport", crate::transport::probe),
        ("github", crate::github::probe),
        ("gitlab", crate::gitlab::probe),
        ("tea", crate::tea::probe),
        ("bitbucket", crate::bitbucket::probe),
        ("origin", crate::origin::probe),
        ("pure", crate::pure::probe),
        ("store", crate::store::probe),
    ]
}

fn object<'a>(value: &'a Value, field: &str) -> &'a ace_json::Map {
    value
        .as_object()
        .and_then(|fields| fields.get(field))
        .and_then(Value::as_object)
        .expect("the field is an object")
}

#[test]
fn every_part_defers_to_typescript_naming_itself_and_the_operation() {
    for (part, probe) in parts() {
        let error = probe("status").expect_err("F0's probes defer");
        assert!(error.is_stub(), "{part}");
        assert_eq!(error.kind(), "cli", "{part}");
        let payload = ace_json::parse(&error.to_payload()).expect("the payload is JSON");
        let fields = payload.as_object().expect("the payload is an object");
        assert_eq!(fields.get("kind"), Some(&Value::from("cli")), "{part}");
        assert_eq!(fields.get("retryAt"), Some(&Value::Null), "{part}");
        assert_eq!(fields.get("dispatched"), Some(&Value::Null), "{part}");
        let details = object(&payload, "details");
        assert_eq!(details.get("stub"), Some(&Value::from(true)), "{part}");
        assert_eq!(details.get("part"), Some(&Value::from(part)), "{part}");
        assert_eq!(details.get("op"), Some(&Value::from("status")), "{part}");
    }
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

#[test]
fn each_module_declares_the_part_name_the_deferral_uses() {
    for (part, module_part) in [
        ("transport", crate::transport::PART),
        ("github", crate::github::PART),
        ("gitlab", crate::gitlab::PART),
        ("tea", crate::tea::PART),
        ("bitbucket", crate::bitbucket::PART),
        ("origin", crate::origin::PART),
        ("pure", crate::pure::PART),
        ("store", crate::store::PART),
    ] {
        assert_eq!(part, module_part);
        assert!(parts().iter().any(|(name, _)| *name == module_part));
    }
}
