// SPDX-License-Identifier: Apache-2.0
//! The journal's cases: statement-for-statement behaviour on a real home.

use super::*;
use crate::repository::testsupport::{header, home};

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

fn parts(text: &str) -> Vec<Value> {
    value(&format!(r#"[{{"type":"text","text":"{text}"}}]"#))
        .as_array()
        .expect("parts")
        .to_vec()
}

/// The journal row the receipt writes at acceptance and the delivery re-signs.
fn sent(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command: &str,
    text: &str,
    generation: Option<f64>,
) {
    let key = format!("input:{command}");
    let origin = value(&format!(r#"{{"kind":"person","commandId":"{command}"}}"#));
    register(conn, thread, &key, &parts(text), &origin).expect("register");
    sending(conn, thread, &key, &parts(text), None, generation).expect("sending");
}

#[test]
fn an_echo_by_native_identity_takes_the_inputs_key_origin_and_person_parts() {
    let conn = home("j-identity", &header("j-identity"));
    let thread = "j-identity";
    sent(&conn, thread, "c1", "hello", Some(1.0));
    identify(
        &conn,
        thread,
        &value(r#"{"commandId":"c1","nativeId":"n1"}"#),
    )
    .expect("identify");
    let fact = value(
        r#"{"type":"item.upsert","agent":"root","item":"native-item","draft":{"type":"message","role":"user","nativeId":"n1","parts":[{"type":"text","text":"expanded"}]}}"#,
    );
    let correlated = correlate(&conn, thread, fact, "root", Some(1.0))
        .expect("correlate")
        .expect("a fact");
    assert_eq!(
        ace_json::to_string(&correlated),
        r#"{"type":"item.upsert","agent":"root","item":"input:c1","draft":{"type":"message","role":"user","nativeId":"n1","origin":{"kind":"person","commandId":"c1"},"synthetic":false}}"#
    );
    assert_eq!(
        key_for(&conn, thread, "n1").expect("key"),
        Some("input:c1".into())
    );
}

#[test]
fn a_known_identity_with_no_journal_origin_marks_the_fact_but_keeps_its_item() {
    let conn = home("j-early", &header("j-early"));
    let thread = "j-early";
    identify(
        &conn,
        thread,
        &value(r#"{"commandId":"c9","nativeId":"n9"}"#),
    )
    .expect("identify");
    let fact = value(
        r#"{"type":"item.upsert","agent":"root","item":"native-9","draft":{"type":"message","role":"user","nativeId":"n9"}}"#,
    );
    let correlated = correlate(&conn, thread, fact, "root", None)
        .expect("correlate")
        .expect("a fact");
    assert_eq!(
        ace_json::to_string(&correlated),
        r#"{"type":"item.upsert","agent":"root","item":"native-9","draft":{"type":"message","role":"user","nativeId":"n9","origin":{"kind":"person","commandId":"c9"},"synthetic":false}}"#
    );
}

#[test]
fn an_echo_correlates_by_signature_only_in_the_generation_that_was_handed_it() {
    let conn = home("j-signature", &header("j-signature"));
    let thread = "j-signature";
    sent(&conn, thread, "c2", "hello", Some(1.0));
    let fact = value(
        r#"{"type":"item.upsert","agent":"root","item":"native-2","draft":{"type":"message","role":"user","parts":[{"type":"text","text":"hello"}]}}"#,
    );
    let elsewhere = correlate(&conn, thread, fact.clone(), "root", Some(2.0)).expect("correlate");
    assert_eq!(
        ace_json::to_string(&elsewhere.expect("a fact")),
        ace_json::to_string(&fact),
        "another generation's echo stays the provider's item"
    );
    let correlated = correlate(&conn, thread, fact, "root", Some(1.0))
        .expect("correlate")
        .expect("a fact");
    assert_eq!(
        correlated.get("item").and_then(Value::as_str),
        Some("input:c2")
    );
    // Its echo row answers the same native item without a signature next time.
    let repeat = value(
        r#"{"type":"item.upsert","agent":"root","item":"native-2","draft":{"type":"message","role":"user"}}"#,
    );
    let echoed = correlate(&conn, thread, repeat, "root", Some(1.0))
        .expect("correlate")
        .expect("a fact");
    assert_eq!(echoed.get("item").and_then(Value::as_str), Some("input:c2"));
}

#[test]
fn a_native_identity_cannot_be_reused_for_a_different_command() {
    let conn = home("j-conflict", &header("j-conflict"));
    let thread = "j-conflict";
    identify(
        &conn,
        thread,
        &value(r#"{"commandId":"c1","nativeId":"n1"}"#),
    )
    .expect("identify");
    let error = identify(
        &conn,
        thread,
        &value(r#"{"commandId":"c2","nativeId":"n1"}"#),
    )
    .expect_err("the identity is taken");
    assert_eq!(
        error.to_string(),
        "Provider reused an input message identity for a different command"
    );
}

#[test]
fn a_wake_with_an_unrecorded_identity_and_no_command_is_never_the_persons_input() {
    // `!identity`, not `nativeId === undefined`: the provider may name an id this home never
    // recorded, and an ace-authored message (a background completion) has no command id.
    let conn = home("j-wake", &header("j-wake"));
    let thread = "j-wake";
    sent(&conn, thread, "c-wake", "wake", Some(1.0));
    let wake = value(
        r#"{"type":"item.upsert","agent":"root","item":"native-wake","draft":{"type":"message","role":"user","nativeId":"unrecorded","parts":[{"type":"text","text":"wake"}],"origin":{"kind":"background_completion"}}}"#,
    );
    let correlated = correlate(&conn, thread, wake.clone(), "root", Some(1.0))
        .expect("correlate")
        .expect("a fact");
    assert_eq!(
        ace_json::to_string(&correlated),
        ace_json::to_string(&wake),
        "an ace-authored wake keeps its own item and origin"
    );
}

#[test]
fn an_identity_the_schema_refuses_is_the_zod_error_text() {
    let conn = home("j-zod", &header("j-zod"));
    let thread = "j-zod";
    let too_long = format!(r#"{{"commandId":"c","nativeId":"{}"}}"#, "x".repeat(257));
    let error = identify(&conn, thread, &value(&too_long)).expect_err("too long");
    assert_eq!(
        error.to_string(),
        "[\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_big\",\n    \"maximum\": 256,\n    \"inclusive\": true,\n    \"path\": [\n      \"nativeId\"\n    ],\n    \"message\": \"Too big: expected string to have <=256 characters\"\n  }\n]"
    );
    let error = identify(&conn, thread, &value(r#"{"nativeId":"n"}"#)).expect_err("no command");
    assert_eq!(
        error.to_string(),
        "[\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"commandId\"\n    ],\n    \"message\": \"Invalid input: expected string, received undefined\"\n  }\n]"
    );
    let error = identify(&conn, thread, &value(r#"{"commandId":"","nativeId":"n"}"#))
        .expect_err("empty command");
    assert_eq!(
        error.to_string(),
        "[\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"inclusive\": true,\n    \"path\": [\n      \"commandId\"\n    ],\n    \"message\": \"Too small: expected string to have >=1 characters\"\n  }\n]"
    );
}
