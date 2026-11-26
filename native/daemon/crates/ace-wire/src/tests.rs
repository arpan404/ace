// SPDX-License-Identifier: Apache-2.0
//! What the wire layer promises the transport and the daemon: the envelope's routing ids,
//! Zod's accept/reject decisions for the rules JSON Schema can't state, and Zod's key order in
//! outbound bytes.

use ace_json::{Value, parse, to_string};

use crate::{
    WireError, decode_client, decode_server, encode_client, encode_server, encode_server_body,
    envelope,
};

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

#[test]
fn a_typed_message_with_a_thread_status_encodes_back_to_the_same_bytes() {
    for status in [
        r#"{"state":"working","agents":1}"#,
        r#"{"state":"made_up","detail":2}"#,
    ] {
        let text = format!(
            r#"{{"type":"events","subscriptionId":"s","afterSeq":0,"throughSeq":1,"events":[{{"seq":1,"id":"e","at":1,"threadId":"t","payload":{{"type":"thread.updated","status":{status}}}}}]}}"#
        );
        let decoded = decode_server(&text).expect("a server message");
        let canonical = encode_server(&decoded.value).expect("bytes");
        assert_eq!(
            encode_server_body(&decoded.message).expect("typed bytes"),
            canonical
        );
    }
}

fn canonical_client_text(text: &str) -> String {
    let decoded = decode_client(text).expect("a client message");
    encode_client(&decoded.value).expect("canonical bytes")
}

#[test]
fn defaults_are_filled_before_the_typed_decode() {
    assert_eq!(
        canonical_client_text(
            r#"{"type":"thread.search","requestId":"r","threadId":"t","text":"x"}"#
        ),
        r#"{"type":"thread.search","requestId":"r","threadId":"t","text":"x","scope":"thread","limit":30}"#
    );
    assert_eq!(
        canonical_client_text(
            r#"{"type":"items.window","requestId":"r","threadId":"t","aroundSeq":10}"#
        ),
        r#"{"type":"items.window","requestId":"r","threadId":"t","aroundSeq":10,"before":50,"after":50}"#
    );
    assert_eq!(
        canonical_client_text(r#"{"type":"turns.page","requestId":"r","threadId":"t"}"#),
        r#"{"type":"turns.page","requestId":"r","threadId":"t","limit":50}"#
    );
}

#[test]
fn a_loose_object_keeps_its_unnamed_keys() {
    let text = r#"{"type":"browser.annotation","threadId":"t","event":{"kind":"ready","url":"https://x","extra":1}}"#;
    let decoded = decode_server(text).expect("a server message");
    assert_eq!(encode_server(&decoded.value).expect("bytes"), text);
}

#[test]
fn string_and_array_bounds_are_refused_as_zod_refuses_them() {
    for text in [
        r#"{"type":"subscribe","subscriptionId":"","scope":{"kind":"thread","threadId":"t"}}"#,
        r#"{"type":"subscribe","subscriptionId":"s","scope":{"kind":"thread","threadId":"t"},"tail":{"items":500,"bytes":1024}}"#,
        r#"{"type":"subscribe","subscriptionId":"s","scope":{"kind":"thread","threadId":"t"},"tail":{"items":1,"bytes":1}}"#,
        r#"{"type":"output.read","requestId":"r","streamId":"s","offset":0,"limit":1000000000}"#,
        r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","trims":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"#,
        r#"{"type":"hello","protocolVersion":1,"deviceId":"d","grant":""}"#,
        r#"{"type":"items.window","requestId":"r","threadId":"t","aroundSeq":10,"before":150,"after":150}"#,
        r#"{"type":"turns.page","requestId":"r","threadId":"t","before":1,"after":1}"#,
        r#"{"type":"thread.catchUp","requestId":"r","threadId":"t"}"#,
    ] {
        assert!(decode_client(text).is_err(), "accepted {text}");
    }
    assert!(
        decode_client(
            r#"{"type":"output.read","requestId":"r","streamId":"s","offset":0,"limit":262144}"#
        )
        .is_ok()
    );
}

#[test]
fn an_unknown_thread_state_is_read_as_unknown_with_its_raw_value() {
    let text = r#"{"type":"events","subscriptionId":"s","afterSeq":0,"throughSeq":1,"events":[{"seq":1,"id":"e","at":1,"threadId":"t","payload":{"type":"thread.updated","status":{"state":"future","extra":1}}}]}"#;
    let decoded = decode_server(text).expect("a server message");
    let canonical = encode_server(&decoded.value).expect("bytes");
    assert!(
        canonical.contains(r#""status":{"state":"unknown","raw":{"state":"future","extra":1}}"#),
        "{canonical}"
    );
}

#[test]
fn an_unparsable_last_close_report_is_dropped_and_a_known_one_keeps_other() {
    let dropped = canonical_client_text(
        r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","lastClose":{"cause":"future"}}"#,
    );
    assert!(!dropped.contains("lastClose"), "{dropped}");
    let kept = canonical_client_text(
        r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","lastClose":{"code":1,"cause":"future","wasReady":true,"attempt":0}}"#,
    );
    assert!(kept.contains(r#""cause":"other""#), "{kept}");
}

#[test]
fn an_unknown_search_state_is_read_as_unknown() {
    let text = r#"{"type":"search.results","requestId":"r","hits":[{"threadId":"t","threadTitle":"t","workspaceId":"w","provider":"claude","status":"future","statusSeq":1,"kind":"thread","createdAt":1,"title":{"text":"x","highlights":[]},"snippet":{"text":"x","highlights":[]},"score":1}],"cursor":"a","generation":1}"#;
    let decoded = decode_server(text).expect("a server message");
    let canonical = encode_server(&decoded.value).expect("bytes");
    assert!(canonical.contains(r#""status":"unknown""#), "{canonical}");
    assert!(canonical.contains(r#""score":1"#), "{canonical}");
}

#[test]
fn a_plain_union_message_decodes_and_encodes_by_its_type() {
    let text = r#"{"type":"user_browser.register","requestId":"r","version":1,"browser":{"family":"chrome","version":"1","profileId":"p","extensionVersion":"1"}}"#;
    let decoded = decode_client(text).expect("a client message");
    assert_eq!(decoded.envelope.type_, "user_browser.register");
    assert_eq!(encode_client(&decoded.value).expect("bytes"), text);
}
