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
fn a_typed_message_keeps_a_known_or_unknown_thread_status() {
    for (status, expected) in [
        (
            r#"{"state":"working","agents":1}"#,
            r#"{"state":"working","agents":1}"#,
        ),
        (
            r#"{"state":"made_up","detail":2}"#,
            r#"{"state":"unknown","raw":{"state":"made_up","detail":2}}"#,
        ),
    ] {
        let text = format!(
            r#"{{"type":"events","subscriptionId":"s","afterSeq":0,"throughSeq":1,"events":[{{"seq":1,"id":"e","at":1,"threadId":"t","payload":{{"type":"thread.updated","status":{status}}}}}]}}"#
        );
        let decoded = decode_server(&text).expect("a server message");
        let typed = encode_server_body(&decoded.message).expect("typed bytes");
        let expected = format!(
            r#"{{"type":"events","subscriptionId":"s","afterSeq":0,"throughSeq":1,"events":[{{"seq":1,"id":"e","at":1,"threadId":"t","payload":{{"type":"thread.updated","status":{expected}}}}}]}}"#
        );
        assert_eq!(typed, expected);
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
fn a_loose_object_keeps_its_unnamed_keys_in_the_typed_body_too() {
    let text =
        r#"{"type":"browser.annotation","threadId":"t","event":{"kind":"future","extra":1}}"#;
    let decoded = decode_server(text).expect("a server message");
    assert_eq!(encode_server(&decoded.value).expect("bytes"), text);
    // The typed body keeps `extra` rather than dropping it with the struct's named fields.
    assert_eq!(
        encode_server_body(&decoded.message).expect("typed bytes"),
        r#"{"type":"browser.annotation","threadId":"t","event":{"kind":"future","extra":1}}"#
    );
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
fn browser_backend_server_messages_decode_on_the_worker_connection() {
    let cases = [
        (
            r#"{"type":"browser.backend.registered","requestId":"r","backendId":"b","connectionId":"c"}"#,
            r#"{"type":"browser.backend.registered","requestId":"r","backendId":"b","connectionId":"c"}"#,
        ),
        (
            r#"{"type":"browser.backend.request","id":"q","backendId":"b","sessionId":"s","operation":{"kind":"close"}}"#,
            r#"{"backendId":"b","sessionId":"s","type":"browser.backend.request","id":"q","operation":{"kind":"close"}}"#,
        ),
        (
            r#"{"type":"browser.backend.frameAck","backendId":"b","sessionId":"s","frameId":1}"#,
            r#"{"backendId":"b","sessionId":"s","type":"browser.backend.frameAck","frameId":1}"#,
        ),
    ];
    for (input, canonical) in cases {
        let decoded = decode_server(input).expect("a browser-backend server message");
        assert_eq!(encode_server(&decoded.value).expect("bytes"), canonical);
    }
}

#[test]
fn items_window_rejects_before_plus_defaulted_after_at_two_hundred() {
    assert!(
        decode_client(
            r#"{"type":"items.window","requestId":"r","threadId":"t","aroundSeq":10,"before":150}"#
        )
        .is_err()
    );
}

#[test]
fn a_plain_union_message_decodes_and_encodes_by_its_type() {
    let text = r#"{"type":"user_browser.register","requestId":"r","version":1,"browser":{"family":"chrome","version":"1","profileId":"p","extensionVersion":"1"}}"#;
    let decoded = decode_client(text).expect("a client message");
    assert_eq!(decoded.envelope.type_, "user_browser.register");
    assert_eq!(encode_client(&decoded.value).expect("bytes"), text);
}

#[test]
fn skills_files_only_read_paths_inside_the_skill_folder() {
    let id = "a".repeat(40);
    let nested = format!(
        r#"{{"type":"skills.request","requestId":"r","operation":{{"op":"files","id":"skl_{id}","path":"src/main.ts"}}}}"#
    );
    assert!(decode_client(&nested).is_ok());
    for path in ["../x", "a/../b", "/etc/passwd", "a\\b", ".git/config"] {
        let text = format!(
            r#"{{"type":"skills.request","requestId":"r","operation":{{"op":"files","id":"skl_{id}","path":"{path}"}}}}"#
        );
        assert!(decode_client(&text).is_err(), "accepted {path}");
    }
}

#[test]
fn the_service_owned_mcp_name_ace_is_reserved() {
    for text in [
        r#"{"type":"mcp.add","requestId":"r","threadId":"t","name":"ace","server":{"transport":"command","command":"x"}}"#,
        r#"{"type":"mcp.provider.add","requestId":"r","provider":"claude","name":"ace","server":{"transport":"command","command":"x"}}"#,
    ] {
        assert!(decode_client(text).is_err(), "accepted {text}");
    }
}

#[test]
fn search_filters_keep_after_at_or_before_before() {
    let valid =
        r#"{"type":"search.query","requestId":"r","text":"x","filters":{"after":1,"before":2}}"#;
    assert!(decode_client(valid).is_ok());
    let invalid =
        r#"{"type":"search.query","requestId":"r","text":"x","filters":{"after":2,"before":1}}"#;
    assert!(decode_client(invalid).is_err());
}

#[test]
fn an_automation_schedule_starts_on_a_whole_minute() {
    let text = |start: u64| {
        format!(
            r#"{{"type":"automation.put","requestId":"r","automation":{{"id":"a","title":"t","enabled":true,"workspace":"w","provider":"claude","prompt":"hi","worktree":false,"trigger":{{"kind":"schedule","schedule":{{"kind":"rrule","expression":"FREQ=DAILY","timezone":"UTC","startAt":{start}}}}},"missedRun":"skip","concurrency":1,"jitterMs":0}}}}"#
        )
    };
    assert!(decode_client(&text(60_000)).is_ok());
    assert!(decode_client(&text(61_000)).is_err());
}

#[test]
fn a_review_position_names_a_safe_path_and_a_bounded_range() {
    let text = |file: &str, end: u64| {
        format!(
            r#"{{"type":"command","command":{{"id":"c","deviceId":"d","payload":{{"type":"review.comment","sessionId":"s","position":{{"file":"{file}","side":"new","start":1,"end":{end}}},"text":"x"}}}}}}"#
        )
    };
    assert!(decode_client(&text("src/main.ts", 10)).is_ok());
    assert!(decode_client(&text("../x", 10)).is_err());
    assert!(decode_client(&text("src/main.ts", 101)).is_err());
}

#[test]
fn a_model_row_keeps_its_raw_json_inside_its_byte_limit() {
    let text = |json: &str| {
        format!(
            r#"{{"type":"models.result","requestId":"r","result":{{"models":[{{"id":"id","displayName":"d","provider":"claude","instance":"i","nativeModelId":"m","efforts":[],"serviceTiers":[],"inputModalities":[],"isDefault":false,"hidden":false,"deprecated":false,"raw":{{"json":"{json}","truncated":false}}}}],"instances":[]}}}}"#
        )
    };
    assert!(decode_server(&text("{}")).is_ok());
    // 1500 two-byte characters fit the 2048-code-point limit and not the 2048-byte one.
    assert!(decode_server(&text(&"é".repeat(1500))).is_err());
}

#[test]
fn a_tool_output_tail_is_at_most_four_thousand_and_ninety_six_bytes() {
    let text = |tail: &str| {
        format!(
            r#"{{"type":"items.page","requestId":"r","seq":1,"threadId":"t","items":[{{"id":"i","agentId":"a","createdAt":1,"type":"tool_call","call":{{"id":"c","agentId":"a","kind":"shell","title":"t","status":"succeeded","detail":{{"kind":"shell","command":"x","output":{{"streamId":"s","bytes":1,"tail":"{tail}","truncated":false}}}},"startedAt":1,"raw":[]}}}}],"itemsBefore":null,"itemSeqs":{{"i":1}}}}"#
        )
    };
    assert!(decode_server(&text(&"a".repeat(4096))).is_ok());
    assert!(decode_server(&text(&"a".repeat(4097))).is_err());
}

#[test]
fn a_trimmed_display_name_must_still_have_text_after_trimming() {
    let text = |name: &str| {
        format!(
            r#"{{"type":"marketplace.request","requestId":"r","operation":{{"op":"publish","request":{{"action":"createProfile","profile":{{"handle":"abc","displayName":"{name}","bio":"","links":[]}}}}}}}}"#
        )
    };
    assert!(decode_client(&text("Ada")).is_ok());
    assert!(decode_client(&text("   ")).is_err());
}

#[test]
fn a_plain_number_must_be_finite() {
    let text = r#"{"type":"files.error","code":"x","message":"m","channel":1e400}"#;
    assert!(decode_server(text).is_err());
}

#[test]
fn a_remote_name_matches_javascripts_ascii_word_class() {
    let text = |remote: &str| {
        format!(
            r#"{{"type":"command","command":{{"id":"c","deviceId":"d","payload":{{"type":"thread.create","workspaceId":"w","provider":"claude","input":[{{"type":"text","text":"x"}}],"base":{{"ref":"main","remote":"{remote}"}}}}}}}}"#
        )
    };
    assert!(decode_client(&text("origin")).is_ok());
    assert!(decode_client(&text("café")).is_err());
}

#[test]
fn an_unknown_thread_state_keeps_zods_length_rule_and_strips_extra_keys() {
    let event = |status: &str| {
        format!(
            r#"{{"type":"events","subscriptionId":"s","afterSeq":0,"throughSeq":1,"events":[{{"seq":1,"id":"e","at":1,"threadId":"t","payload":{{"type":"thread.updated","status":{status}}}}}]}}"#
        )
    };
    assert!(decode_server(&event(r#"{"state":""}"#)).is_err());
    assert!(decode_server(&event(&format!(r#"{{"state":"{}"}}"#, "x".repeat(65)))).is_err());
    let decoded = decode_server(&event(r#"{"state":"unknown","raw":{},"extra":1}"#))
        .expect("a known unknown status");
    assert_eq!(
        encode_server(&decoded.value).expect("bytes"),
        event(r#"{"state":"unknown","raw":{}}"#)
    );
}

#[test]
fn a_record_key_must_fit_its_schema() {
    let invalid = r#"{"type":"mcp.replace","requestId":"r","threadId":"t","servers":{"":null}}"#;
    assert!(decode_client(invalid).is_err());
    let valid = r#"{"type":"mcp.replace","requestId":"r","threadId":"t","servers":{"x":null}}"#;
    assert!(decode_client(valid).is_ok());
}

#[test]
fn an_opaque_id_map_keeps_a_proto_key_and_its_item_sequence() {
    let text = r#"{"type":"items.page","requestId":"r","seq":1,"threadId":"t","items":[{"id":"__proto__","agentId":"a","createdAt":1,"type":"unknown","data":null}],"itemsBefore":null,"itemSeqs":{"__proto__":1}}"#;
    let decoded = decode_server(text).expect("an items page");
    let canonical = encode_server(&decoded.value).expect("bytes");
    assert!(
        canonical.contains(r#""itemSeqs":{"__proto__":1}"#),
        "{canonical}"
    );
}

#[test]
fn an_optional_null_and_an_optional_empty_array_keep_their_presence() {
    let null = r#"{"type":"files.error","code":"x","message":"m","current":null}"#;
    let decoded = decode_server(null).expect("a files error");
    assert_eq!(
        encode_server_body(&decoded.message).expect("typed bytes"),
        null
    );
    let empty = r#"{"type":"hello","protocolVersion":1,"deviceId":"d","token":"a","trims":[]}"#;
    let decoded = decode_client(empty).expect("a hello");
    assert_eq!(
        crate::encode_client_body(&decoded.message).expect("typed bytes"),
        empty
    );
}
