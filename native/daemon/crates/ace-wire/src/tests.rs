// SPDX-License-Identifier: Apache-2.0
//! What the wire layer promises the transport and the daemon: the envelope's routing ids,
//! Zod's accept/reject decisions for the rules JSON Schema can't state, and Zod's key order in
//! outbound bytes.

use ace_json::{Value, parse, to_string};

use crate::{WireError, decode_client, encode_client, encode_server, envelope};

fn value(text: &str) -> Value {
    parse(text).expect("a test's own JSON")
}

#[test]
fn an_envelope_reads_the_type_and_the_routing_ids() {
    let message = value(r#"{"type":"items.page","requestId":"r","subscriptionId":"s"}"#);
    let envelope = envelope(&message).expect("an envelope");
    assert_eq!(envelope.type_, "items.page");
    assert_eq!(envelope.request_id.as_deref(), Some("r"));
    assert_eq!(envelope.subscription_id.as_deref(), Some("s"));
}

#[test]
fn a_command_envelope_names_the_thread_its_payload_targets() {
    let message = value(
        r#"{"type":"command","command":{"id":"c","deviceId":"d","payload":{"type":"thread.markRead","threadId":"t"}}}"#,
    );
    assert_eq!(
        envelope(&message)
            .expect("an envelope")
            .thread_id
            .as_deref(),
        Some("t")
    );
}

#[test]
fn a_message_without_a_type_is_refused() {
    assert!(matches!(
        envelope(&value(r#"{"requestId":"r"}"#)),
        Err(WireError::MissingType)
    ));
    assert!(matches!(
        envelope(&value("[]")),
        Err(WireError::NotAnObject)
    ));
}

#[test]
fn a_type_no_union_defines_is_refused() {
    assert!(matches!(
        decode_client(r#"{"type":"nope"}"#),
        Err(WireError::UnknownType { type_ }) if type_ == "nope"
    ));
}

#[test]
fn hello_with_two_credentials_is_refused_though_it_parses() {
    let text = r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","ticket":"b"}"#;
    assert!(matches!(
        decode_client(text),
        Err(WireError::Refinement { type_, .. }) if type_ == "hello"
    ));
    let one = r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a"}"#;
    assert!(decode_client(one).is_ok());
}

#[test]
fn ping_decodes_and_encodes_as_it_arrived() {
    let decoded = decode_client(r#"{"type":"ping"}"#).expect("a ping");
    assert_eq!(decoded.envelope.type_, "ping");
    assert_eq!(
        encode_client(&decoded.value).expect("bytes"),
        r#"{"type":"ping"}"#
    );
}

#[test]
fn a_snapshot_is_written_in_the_schema_key_order() {
    // `view`'s own keys are in `ThreadListView`'s order, not the order the producer wrote them.
    let text = r#"{"type":"snapshot","subscriptionId":"s","seq":1,"view":{"threads":{},"seq":1,"kind":"threads"}}"#;
    assert_eq!(
        encode_server(&value(text)).expect("bytes"),
        r#"{"type":"snapshot","subscriptionId":"s","seq":1,"view":{"kind":"threads","seq":1,"threads":{}}}"#
    );
}

#[test]
fn a_hello_is_written_in_the_schema_key_order() {
    let text = r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","trims":["raw-on-demand"]}"#;
    assert_eq!(
        encode_client(&value(text)).expect("bytes"),
        r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","trims":["raw-on-demand"]}"#
    );
}

#[test]
fn keys_zod_strips_are_not_written() {
    let text = r#"{"type":"ping","extra":1}"#;
    assert_eq!(
        encode_client(&value(text)).expect("bytes"),
        r#"{"type":"ping"}"#
    );
}

#[test]
fn bytes_are_the_same_when_written_twice() {
    let text = r#"{"type":"pong"}"#;
    let first = encode_server(&value(text)).expect("bytes");
    let second = encode_server(&value(&first)).expect("bytes");
    assert_eq!(first, second);
    assert_eq!(first, to_string(&value(text)));
}
