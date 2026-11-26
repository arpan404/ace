// SPDX-License-Identifier: Apache-2.0
//! The cases of `packages/redaction/src`'s eleven test files, moved with the module (ADR 0224
//! §11, F0). One difference in form only: a Rust `Context` cannot hold a throwing getter, so
//! `index.test.ts`'s "context cannot be read" case has no analogue here.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use super::{Context, Redactor};

fn context(env: &[(&str, &str)]) -> Context {
    Context {
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
        ..Context::default()
    }
}

fn text(redactor: &Redactor, value: &str) -> String {
    redactor.text(value)
}

fn record(redactor: &Redactor, value: &str) -> String {
    redactor.record(&[], value)
}

fn parsed(redactor: &Redactor, value: &str) -> ace_json::Value {
    ace_json::parse(&record(redactor, value)).expect("redacted records stay valid JSON")
}

fn streamed(redactor: &Redactor, value: &str) -> String {
    redactor
        .stream(value)
        .expect("the test's text fits the chunk budget")
        .join("")
}

// index.test.ts
#[test]
fn literal_redaction_survives_environment_key_collisions_and_json_escaping() {
    let redactor = Redactor::new(&context(&[
        ("USER", "text"),
        ("CURSOR_API_KEY", "opaque-key-value"),
    ]));
    assert_eq!(text(&redactor, "reason: opaque-key-value"), "reason: <ENV>");
    let escaped = "\0".repeat(65_536);
    assert_eq!(text(&redactor, &escaped), escaped);
    assert_eq!(
        streamed(&redactor, "[partial text opaque-key-value"),
        "[partial <ENV> <ENV>"
    );
}

#[test]
fn the_daemons_listen_mode_stays_readable_while_secrets_beside_it_are_scrubbed() {
    let redactor = Redactor::new(&context(&[
        ("ACE_LISTEN", "tailscale"),
        ("CURSOR_API_KEY", "opaque-key-value"),
    ]));
    assert_eq!(
        text(
            &redactor,
            "Run `sudo tailscale set --operator=$USER` (opaque-key-value)"
        ),
        "Run `sudo tailscale set --operator=$USER` (<ENV>)"
    );
}

#[test]
fn file_url_home_roots_stay_private_while_nested_operational_paths_survive() {
    let redactor = Redactor::new(&Context::default());
    let clean = parsed(
        &redactor,
        &serde_like(&[
            ("mac", "file:///Users/alice/private.txt"),
            ("linux", "file://localhost/home/alice/private.txt"),
            ("encoded", "file:///Users/alice%20smith/private.txt"),
            ("absolute", "/home/alice/private.txt"),
            ("operational", "file:///tmp/home/worktrees/project"),
            ("nested", "/tmp/home/worktrees/project"),
        ]),
    );
    let object = clean.as_object().expect("an object");
    for (key, expected) in [
        ("mac", "file://<HOME>/private.txt"),
        ("linux", "file://localhost<HOME>/private.txt"),
        ("encoded", "file://<HOME>/private.txt"),
        ("absolute", "<HOME>/private.txt"),
        ("operational", "file:///tmp/home/worktrees/project"),
        ("nested", "/tmp/home/worktrees/project"),
    ] {
        assert_eq!(
            object
                .get(key)
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default(),
            expected,
            "{key}"
        );
    }
}

#[test]
fn literal_stream_fragments_keep_json_delimiters_while_structural_payloads_are_scrubbed() {
    let redactor = Redactor::new(&context(&[("CURSOR_API_KEY", "sentinel-credential")]));
    let payload = r#"{"refreshToken":["OPAQUE_REFRESH"],"password":{"value":"OPAQUE_PASSWORD"}}"#;
    for fragment in ["{", "[", "\"", "{\"visible\":"] {
        let line = format!(r#"{{"text":{},"payload":{payload}}}"#, quoted(fragment));
        let clean = redactor.record(&["text"], &line);
        assert!(
            clean.contains(&format!(r#""text":{}"#, quoted(fragment))),
            "{line} -> {clean}"
        );
        assert!(!clean.contains("OPAQUE"), "{clean}");
    }
    let line = format!(r#"{{"text":"sentinel-credential","payload":{payload}}}"#);
    let clean = redactor.record(&["text"], &line);
    assert!(clean.contains(r#""text":"<ENV>""#), "{clean}");
}

#[test]
fn embedded_colliding_and_deep_records_cannot_expose_secrets() {
    let redactor = Redactor::new(&Context {
        home: Some(String::from("/private/home")),
        ..Context::default()
    });
    let payload = r#"[{"refreshToken":["OPAQUE_REFRESH"],"password":{"value":"OPAQUE_PASSWORD"}}]"#;
    let payload_object =
        r#"{"refreshToken":["OPAQUE_REFRESH"],"password":{"value":"OPAQUE_PASSWORD"}}"#;
    for line in [
        format!(r#"{{"payload":"{}"}}"#, payload_object.replace('"', "\\\"")),
        String::from(
            r#"{{"/private/home":1,"<HOME>":2,"refreshToken":["OPAQUE_REFRESH"],"password":{"value":"OPAQUE_PASSWORD"}}}"#,
        ),
        format!("{}1{}", "[".repeat(10_000), "]".repeat(10_000)),
        String::from(r#"{"refreshToken":["OPAQUE_REFRESH"]"#),
        payload.to_owned(),
    ] {
        let clean = record(&redactor, &line);
        assert!(!clean.contains("OPAQUE_REFRESH"), "{clean}");
        assert!(!clean.contains("OPAQUE_PASSWORD"), "{clean}");
        assert!(ace_json::parse(&clean).is_ok(), "{clean}");
    }
}

#[test]
fn mixed_case_authorization_is_removed_while_arrays_and_the_recorder_email_survive() {
    let redactor = Redactor::new(&Context::default());
    let clean = parsed(
        &redactor,
        r#"{"message":"bEaReR OPAQUE_ACCESS","values":[1,true,"visible"],"email":"recorder@ace.invalid","privateEmail":"person@example.com"}"#,
    );
    let object = clean.as_object().expect("an object");
    let value = |key: &str| object.get(key).cloned().unwrap_or(ace_json::Value::Null);
    assert_eq!(value("message"), ace_json::Value::from("<SECRET>"));
    assert_eq!(
        value("values"),
        ace_json::parse(r#"[1,true,"visible"]"#).expect("test JSON")
    );
    assert_eq!(
        value("email"),
        ace_json::Value::from("recorder@ace.invalid")
    );
    assert_eq!(value("privateEmail"), ace_json::Value::from("<EMAIL>"));
}

#[test]
fn json_string_wrappers_cannot_hide_structural_secrets() {
    let redactor = Redactor::new(&Context::default());
    let secret = "OPAQUE_WRAPPED_REFRESH";
    let mut wrapped = format!(r#"{{"refreshToken":["{secret}"],"values":[1,"visible"]}}"#);
    for depth in 0..3 {
        wrapped = ace_json::to_string(&ace_json::Value::from(wrapped.as_str()));
        let clean = record(&redactor, &serde_like(&[("payload", wrapped.as_str())]));
        assert!(!clean.contains(secret), "{clean}");
        let mut decoded = clean_value_payload(&clean);
        for _ in 0..=depth + 1 {
            let text = decoded.as_str().expect("an encoded JSON string").to_owned();
            decoded = ace_json::parse(&text).expect("valid encoded JSON");
        }
        assert_eq!(
            decoded,
            ace_json::parse(r#"{"refreshToken":"<SECRET>","values":[1,"visible"]}"#)
                .expect("test JSON")
        );
    }
}

fn clean_value_payload(clean: &str) -> ace_json::Value {
    let value = ace_json::parse(clean).expect("valid JSON");
    value
        .as_object()
        .and_then(|object| object.get("payload").cloned())
        .expect("a payload")
}

/// A JSON object literal from pairs, with `JSON.stringify`'s escaping of each value.
fn serde_like(pairs: &[(&str, &str)]) -> String {
    let mut object = ace_json::Map::new();
    for (key, value) in pairs {
        object.insert(*key, ace_json::Value::from(*value));
    }
    ace_json::to_string(&ace_json::Value::Object(object))
}

// quoted-passwords.test.ts
#[test]
fn quoted_credentials_are_removed_in_full_across_every_public_redactor() {
    for assignment in [
        "password=\"first private, second; private \\\"quote\\\" tail\"",
        "token='first private, second; private \\'quote\\' tail'",
        "password=\"unclosed private, suffix; tail",
    ] {
        let redactor = Redactor::new(&Context::default());
        let input = format!("before {assignment}");
        assert_eq!(text(&redactor, &input), "before <SECRET>");
        assert_eq!(streamed(&redactor, &input), "before <SECRET>");
        assert_eq!(
            parsed(&redactor, &format!(r#"{{"message":{}}}"#, quoted(&input)))
                .as_object()
                .and_then(|object| object.get("message").cloned()),
            Some(ace_json::Value::from("before <SECRET>"))
        );
        assert_eq!(redactor.diagnostic(&input), "before <SECRET>");
    }
}

fn quoted(text: &str) -> String {
    ace_json::to_string(&ace_json::Value::from(text))
}

#[test]
fn a_quoted_credential_crossing_stream_boundaries_preserves_surrounding_text() {
    let redactor = Redactor::new(&Context::default());
    let prefix = "visible ".repeat(510);
    let secret = "private, suffix; ".repeat(300);
    let input = format!("{prefix}password=\"{secret}\" after");
    assert_eq!(
        streamed(&redactor, &input),
        format!("{prefix}<SECRET> after")
    );
}

#[test]
fn an_environment_match_cannot_shorten_a_quoted_credential() {
    for value in ["Authorization", "OPAQUE_HEADER"] {
        let redactor = Redactor::new(&context(&[("CUSTOM", value)]));
        let input = r#"before Authorization: "OPAQUE_HEADER_CREDENTIAL" after"#;
        assert_eq!(text(&redactor, input), "before <SECRET> after");
        assert_eq!(redactor.diagnostic(input), "before <SECRET> after");
        assert_eq!(
            parsed(&redactor, &format!(r#"{{"message":{}}}"#, quoted(input)))
                .as_object()
                .and_then(|object| object.get("message").cloned()),
            Some(ace_json::Value::from("before <SECRET> after"))
        );
        assert_eq!(streamed(&redactor, input), "before <SECRET> after");
    }
}

#[test]
fn escaped_configured_secrets_crossing_a_stream_boundary_remain_private() {
    let value = "left{ \"value\": \"OPAQUE_ENV_CREDENTIAL\" }right";
    let redactor = Redactor::new(&context(&[("CUSTOM", value)]));
    let prefix = "A".repeat(4_090);
    let escaped = ace_json::to_string(&ace_json::Value::from(value))
        .trim_matches('"')
        .to_owned();
    assert_eq!(
        streamed(&redactor, &format!("{prefix}{escaped} after")),
        format!("{prefix}<ENV> after")
    );
}

// credential-overlap.test.ts
#[test]
fn configured_prefixes_cannot_expose_the_rest_of_a_credential() {
    for (value, evidence) in [
        ("password", "password=OPAQUE_BARE_CREDENTIAL"),
        ("Bearer", "Bearer OPAQUE_HEADER_CREDENTIAL"),
        ("Basic", "Basic OPAQUE_HEADER_CREDENTIAL"),
        ("sk-ant-", "sk-ant-OPAQUE_PROVIDER_CREDENTIAL"),
    ] {
        let redactor = Redactor::new(&context(&[("CUSTOM", value)]));
        for input in [
            evidence.to_owned(),
            format!(r#"{{"message":"{evidence}"}}"#),
        ] {
            for safe in [
                text(&redactor, &input),
                record(&redactor, &input),
                redactor.diagnostic(&input),
            ] {
                assert!(!safe.contains("OPAQUE"), "{input} -> {safe}");
                assert!(safe.contains("<SECRET>"), "{input} -> {safe}");
            }
        }
        let prefix = format!("{} ", "A".repeat(4_089));
        assert_eq!(
            streamed(&redactor, &format!("{prefix}{evidence} after")),
            format!("{prefix}<SECRET> after")
        );
    }
}

#[test]
fn streaming_masks_a_credential_value_when_its_key_crosses_a_chunk_boundary() {
    let redactor = Redactor::new(&Context::default());
    let input = format!(
        "{}{{\"password\":\"OPAQUE_JSON_CREDENTIAL\"}} after",
        "A".repeat(4_084)
    );
    let safe = streamed(&redactor, &input);
    assert!(!safe.contains("OPAQUE_JSON_CREDENTIAL"), "{safe}");
    assert!(safe.contains(r#""password":"<SECRET>""#), "{safe}");
    assert!(safe.contains("after"), "{safe}");
}

// sdk-counters.test.ts
#[test]
fn numeric_sdk_accounting_counters_survive_while_credential_shaped_values_do_not() {
    let redactor = Redactor::new(&Context::default());
    let clean = parsed(
        &redactor,
        r#"{"usage":{"inputTokens":12,"outputTokens":7,"cacheReadTokens":2,"cacheWriteTokens":3,"reasoningTokens":1,"totalTokens":19},"delta":{"type":"token-delta","tokens":4},"opaque":{"inputTokens":"sentinel-secret","token":"sentinel-secret","apiKey":"sentinel-key","password":123,"totalTokens":"sentinel-secret","tokens":"sentinel-secret"}}"#,
    );
    assert_eq!(
        clean,
        ace_json::parse(
            r#"{"usage":{"inputTokens":12,"outputTokens":7,"cacheReadTokens":2,"cacheWriteTokens":3,"reasoningTokens":1,"totalTokens":19},"delta":{"type":"token-delta","tokens":4},"opaque":{"inputTokens":"<SECRET>","token":"<SECRET>","apiKey":"<SECRET>","password":"<SECRET>","totalTokens":"<SECRET>","tokens":"<SECRET>"}}"#
        )
        .expect("test JSON")
    );
}

// provider-api-key.test.ts
#[test]
fn api_key_messages_stay_secret_in_structured_diagnostic_text_and_streamed_redaction() {
    let key = "opaque-provider-key-with-no-recognizable-prefix";
    let json = format!(
        r#"{{"type":"provider.login.apiKey","requestId":"submit","session":"session","apiKey":"{key}"}}"#
    );
    let redactor = Redactor::new(&Context::default());
    for safe in [
        record(&redactor, &json),
        text(&redactor, &json),
        redactor.diagnostic(&json),
        streamed(&redactor, &json),
    ] {
        assert!(!safe.contains(key), "{safe}");
        assert!(safe.contains("SECRET"), "{safe}");
    }
    assert!(
        !record(
            &redactor,
            &format!(r#"{{"nested":{json},"embedded":{}}}"#, quoted(&json))
        )
        .contains(key)
    );
}

// ambiguous-assignments.test.ts
#[test]
fn ambiguous_prose_cannot_hide_a_sensitive_assignment() {
    let cases = [
        "before \" {\":token\":\"OPAQUE_CREDENTIAL\"} after",
        "before \\\" {\":token\\\"\":\"OPAQUE_CREDENTIAL\"} after",
        "before \"note\": \" {\"token\":\"OPAQUE_CREDENTIAL\"} after",
        "before \"note\": \" {\"api\\u005fkey\":\"OPAQUE_CREDENTIAL\"} after",
        "before \\\"token\":\"OPAQUE_CREDENTIAL\" after",
        "before \"token\\\": \"OPAQUE_CREDENTIAL\" after",
    ];
    let redactor = Redactor::new(&Context::default());
    for input in cases {
        let expected = input.replace("OPAQUE_CREDENTIAL", "<SECRET>");
        assert_eq!(text(&redactor, input), expected);
        assert_eq!(streamed(&redactor, input), expected);
        for diagnostic in [input.to_owned(), format!(r#"{{"stderr":"{input}"}}"#)] {
            assert!(
                !redactor
                    .diagnostic(&diagnostic)
                    .contains("OPAQUE_CREDENTIAL"),
                "{diagnostic}"
            );
        }
        let prefix = format!("{} ", "A".repeat(4_080));
        assert_eq!(
            streamed(&redactor, &format!("{prefix}{input}")),
            format!("{prefix}{expected}")
        );
    }
}

#[test]
fn repeated_quotes_and_assignments_complete_within_the_streaming_budget() {
    let redactor = Redactor::new(&Context::default());
    for prefix in [
        "\" ".repeat(200_000),
        "\"note\": \" {\"token\":\"private\"} ".repeat(40_000),
    ] {
        let input = format!("{prefix} {{\"token\":\"OPAQUE_CREDENTIAL\"}}");
        let safe = streamed(&redactor, &input);
        assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{safe}");
        assert!(safe.contains("<SECRET>"), "{safe}");
    }
}

// damaged-keys.test.ts
#[test]
fn an_ordinary_suffix_cannot_dismiss_a_damaged_key_candidate() {
    for input in [
        "before \"token\\q\\\"note\":\"OPAQUE_CREDENTIAL\" after",
        "before \"token\\x\\\"note\":\"OPAQUE_CREDENTIAL\" after",
        "before \"token\\uZZZZ\\\"note\":\"OPAQUE_CREDENTIAL\" after",
        "before \"label\\q\\\"note\":\"OPAQUE_CREDENTIAL\" after",
    ] {
        let redactor = Redactor::new(&Context::default());
        let expected = input.replace("OPAQUE_CREDENTIAL", "<SECRET>");
        assert_eq!(text(&redactor, input), expected, "{input}");
        assert_eq!(streamed(&redactor, input), expected, "{input}");
        let prefix = "A".repeat(4_096 - input.find('\\').unwrap_or(0) - 1);
        assert_eq!(
            text(&redactor, &format!("{prefix}{input}")),
            format!("{prefix}{expected}")
        );
        assert_eq!(
            streamed(&redactor, &format!("{prefix}{input}")),
            format!("{prefix}{expected}")
        );
    }
}

#[test]
fn valid_ordinary_key_candidates_retain_their_value_despite_an_escaped_quote() {
    let redactor = Redactor::new(&Context::default());
    let input = "before \"label\\\"note\":\"ordinary\" after";
    assert_eq!(text(&redactor, input), input);
    assert_eq!(streamed(&redactor, input), input);
}

#[test]
fn a_damaged_key_cannot_use_an_ordinary_numeric_suffix_to_bypass_redaction() {
    let redactor = Redactor::new(&Context::default());
    let input = "before \"token\\q\\\"inputTokens\":12 after";
    assert_eq!(
        text(&redactor, input),
        "before \"token\\q\\\"inputTokens\":\"<SECRET>\" after"
    );
    assert!(!streamed(&redactor, input).contains("12"));
}

// json-credentials.test.ts
#[test]
fn prose_quotes_cannot_hide_a_following_json_credential() {
    let redactor = Redactor::new(&Context::default());
    for input in [
        "before \" {\"token\":\"OPAQUE_CREDENTIAL\"} after",
        "before \"one\" \" {\"token\":\"OPAQUE_CREDENTIAL\"} after",
        "before \"one\" \"two\" \" {\"token\":\"OPAQUE_CREDENTIAL\"} after",
        "before {\"note\":\"a \\\"quoted\\\" value\"} \" {\"token\":\"OPAQUE_CREDENTIAL\"} after",
        "before \" {\"note\":\"a \\\"quoted\\\" value\",\"token\":\"OPAQUE_CREDENTIAL\"} after",
    ] {
        let expected = input.replace("OPAQUE_CREDENTIAL", "<SECRET>");
        assert_eq!(text(&redactor, input), expected, "{input}");
        assert_eq!(streamed(&redactor, input), expected, "{input}");
    }
}

#[test]
fn streaming_preserves_the_credential_mask_after_a_prose_quote_at_a_chunk_boundary() {
    let redactor = Redactor::new(&Context::default());
    let prefix = format!("{} \" ", "A".repeat(4_080));
    assert_eq!(
        streamed(
            &redactor,
            &format!("{prefix}{{\"token\":\"OPAQUE_CREDENTIAL\"}} after")
        ),
        format!("{prefix}{{\"token\":\"<SECRET>\"}} after")
    );
}

#[test]
fn json_credential_strings_are_removed_without_losing_ordinary_fields() {
    let redactor = Redactor::new(&Context::default());
    for input in [
        "before {\"prefix_token_suffix\":\"OPAQUE_CREDENTIAL\",\"visible\":\"ok\"} after",
        "before {\"api\\u005fkey\" : \"OPAQUE_CREDENTIAL\",\"visible\":\"ok\"} after",
        "before {\"authorization\":\"OPAQUE_CREDENTIAL \\\"private quote\\\" tail\",\"visible\":\"ok\"} after",
    ] {
        for safe in [text(&redactor, input), streamed(&redactor, input)] {
            assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{safe}");
            assert!(!safe.contains("private quote"), "{safe}");
            assert!(safe.contains("\"<SECRET>\""), "{safe}");
            assert!(safe.contains("\"visible\":\"ok\""), "{safe}");
            assert!(safe.contains("before"), "{safe}");
            assert!(safe.contains("after"), "{safe}");
        }
    }
}

#[test]
fn ordinary_json_string_values_are_not_treated_as_credential_keys() {
    let redactor = Redactor::new(&Context::default());
    let input = "{\"note\":\"token secret authorization\", \"visible\":\"ok\"}";
    assert_eq!(text(&redactor, input), input);
    assert_eq!(streamed(&redactor, input), input);
}

#[test]
fn a_long_credential_key_still_masks_its_value() {
    let redactor = Redactor::new(&Context::default());
    let input = format!("{{\"{}\":\"OPAQUE_CREDENTIAL\"}}", "token ".repeat(8_000));
    for safe in [text(&redactor, &input), streamed(&redactor, &input)] {
        assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{safe}");
        assert_eq!(safe, input.replace("OPAQUE_CREDENTIAL", "<SECRET>"));
    }
}

// diagnostic.test.ts
#[test]
fn configured_spans_crossing_records_cannot_erase_a_later_containers_classification() {
    let evidence = "{\"value\":\"first\"}bridge{\"credentials\":{\"login\":\"OPAQUE_CONTAINER_CREDENTIAL\"},\"code\":7}";
    let redactor = Redactor::new(&context(&[("CUSTOM", "first\"}bridge{\"credentials\":")]));
    for input in [
        evidence.to_owned(),
        format!(r#"{{"stderr":{}}}"#, quoted(evidence)),
    ] {
        let safe = redactor.diagnostic(&input);
        assert!(!safe.contains("OPAQUE_CONTAINER_CREDENTIAL"), "{safe}");
        assert!(safe.contains("<ENV>"), "{safe}");
    }
}

#[test]
fn overlapping_configured_secrets_mask_their_complete_union_in_raw_and_escaped_output() {
    let value = "left{ \"value\": \"OPAQUE_ENV_CREDENTIAL\" }right";
    let redactor = Redactor::new(&context(&[
        ("FIRST", "left{"),
        ("SECOND", "{ \"value\": \"OPAQUE_ENV_CREDENTIAL\" }right"),
    ]));
    for spelling in [
        value.to_owned(),
        ace_json::to_string(&ace_json::Value::from(value))
            .trim_matches('"')
            .to_owned(),
    ] {
        assert_eq!(text(&redactor, &spelling), "<ENV>");
        assert_eq!(redactor.diagnostic(&spelling), "<ENV>");
        let general = record(&redactor, &spelling);
        assert!(!general.contains("OPAQUE"), "{general}");
        assert!(general.contains("<ENV>"), "{general}");
        let prefix = "A".repeat(4_090);
        assert_eq!(
            streamed(&redactor, &format!("{prefix}{spelling} after")),
            format!("{prefix}<ENV> after")
        );
    }
}

#[test]
fn repeated_overlapping_configured_prefixes_keep_the_trailing_credential_private() {
    let first = "A".repeat(129);
    let second = format!("{}B", "A".repeat(128));
    let redactor = Redactor::new(&context(&[("FIRST", &first), ("SECOND", &second)]));
    assert_eq!(
        text(&redactor, &format!("{}B after", "A".repeat(5_000))),
        "<ENV> after"
    );
}

#[test]
fn configured_json_fragments_stay_private_through_normalization_and_escaping() {
    for value in [
        "left{ \"value\": \"OPAQUE_ENV_CREDENTIAL\" }right",
        "left{ \"value\": \"OPAQUE\\u005fENV_CREDENTIAL\" }right",
    ] {
        let redactor = Redactor::new(&context(&[("CUSTOM", value)]));
        for evidence in [
            format!("request failed: {value}"),
            format!("request failed: {}", quoted(value)),
        ] {
            for input in [
                evidence.clone(),
                format!(r#"{{"stderr":{}}}"#, quoted(&evidence)),
            ] {
                let safe = redactor.diagnostic(&input);
                assert!(!safe.contains("OPAQUE"), "{safe}");
                assert!(safe.contains("request failed"), "{safe}");
                assert!(safe.contains("<ENV>"), "{safe}");
            }
        }
    }
}

#[test]
fn environment_values_matching_json_keys_cannot_hide_credential_containers() {
    let redactor = Redactor::new(&context(&[("CUSTOM", "credentials")]));
    let evidence =
        "request failed: {\"credentials\":{\"login\":\"OPAQUE_CONTAINER_CREDENTIAL\"},\"code\":7}";
    for input in [
        evidence.to_owned(),
        format!(r#"{{"stderr":{}}}"#, quoted(evidence)),
    ] {
        let safe = redactor.diagnostic(&input);
        assert!(!safe.contains("OPAQUE_CONTAINER_CREDENTIAL"), "{safe}");
        assert!(safe.contains("<SECRET>"), "{safe}");
        assert!(safe.contains("code"), "{safe}");
        assert!(safe.contains("7"), "{safe}");
    }
}

#[test]
fn the_general_redactor_classifies_prose_containers_without_an_empty_context_pass() {
    let redactor = Redactor::new(&context(&[("CUSTOM", "credentials")]));
    let input =
        "request failed: {\"credentials\":{\"login\":\"OPAQUE_CONTAINER_CREDENTIAL\"},\"code\":7}";
    for evidence in [
        input.to_owned(),
        format!(r#"{{"message":{}}}"#, quoted(input)),
    ] {
        let safe = record(&redactor, &evidence);
        assert!(!safe.contains("OPAQUE_CONTAINER_CREDENTIAL"), "{safe}");
        assert!(safe.contains("request failed"), "{safe}");
        assert!(safe.contains("<SECRET>"), "{safe}");
    }
}

#[test]
fn configured_objects_nested_inside_larger_records_are_masked_before_whitespace_normalization() {
    let value = "{ \"value\": \"OPAQUE_ENV_CREDENTIAL\" }";
    let redactor = Redactor::new(&context(&[("CUSTOM", value), ("KEY", "credentials")]));
    let evidence = format!(
        "request failed: {{\"payload\": {value},\"credentials\":{{\"login\":\"OPAQUE_OTHER_CREDENTIAL\"}},\"code\":7}}"
    );
    for input in [
        evidence.clone(),
        format!(r#"{{"stderr":{}}}"#, quoted(&evidence)),
    ] {
        let safe = redactor.diagnostic(&input);
        assert!(!safe.contains("OPAQUE"), "{safe}");
        assert!(safe.contains("request failed"), "{safe}");
        assert!(safe.contains("<ENV>"), "{safe}");
        assert!(safe.contains("<SECRET>"), "{safe}");
        assert!(safe.contains("code"), "{safe}");
        assert!(safe.contains("7"), "{safe}");
    }
}

#[test]
fn json_escape_decoding_cannot_change_a_configured_secret_into_visible_credential_text() {
    let value = "OPAQUE\\u005fENV_CREDENTIAL";
    let redactor = Redactor::new(&context(&[("CUSTOM", value)]));
    let safe = redactor.diagnostic(&format!(
        "request failed: {{\"payload\":\"{value}\",\"code\":7}}"
    ));
    assert!(!safe.contains("OPAQUE"), "{safe}");
    assert!(safe.contains("<ENV>"), "{safe}");
    assert!(safe.contains("\"code\":7"), "{safe}");
}

#[test]
fn coloured_cli_stderr_stays_readable_while_its_credential_is_redacted() {
    let redactor = Redactor::new(&Context::default());
    let line = "\u{1b}[31mERROR\u{1b}[0m websocket: HTTP error: 403 Forbidden api_key=OPAQUE_STDERR_CREDENTIAL";
    for input in [
        line.to_owned(),
        format!(r#"{{"type":"stderr","data":{}}}"#, quoted(line)),
    ] {
        let safe = redactor.diagnostic(&input);
        assert!(safe.contains("403 Forbidden"), "{safe}");
        assert!(!safe.contains("OPAQUE_STDERR_CREDENTIAL"), "{safe}");
    }
}

#[test]
fn node_warnings_with_bracketed_tags_stay_readable_while_a_credential_beside_them_is_hidden() {
    let redactor = Redactor::new(&Context {
        home: Some(String::from("/Users/someone")),
        ..Context::default()
    });
    for warning in [
        "(node:1877) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
        "(node:1877) MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]. MaxListeners is 10.",
    ] {
        assert_eq!(redactor.diagnostic(warning), warning);
        let line = format!(r#"{{"message":{}}}"#, quoted(warning));
        assert_eq!(redactor.diagnostic(&line), line);
    }
    let leaky =
        redactor.diagnostic("(node:1) [DEP0005] Warning: Bearer abcdefghijklmnopqrstuvwxyz");
    assert!(leaky.contains("[DEP0005]"), "{leaky}");
    assert!(!leaky.contains("abcdefghijklmnopqrstuvwxyz"), "{leaky}");
    assert!(
        !redactor
            .diagnostic("(node:1) [DEP0005] {\"password\":\"opaque-value\"")
            .contains("opaque-value")
    );
}

#[test]
fn ace_account_grants_standing_grants_and_their_proofs_never_reach_a_diagnostic_log() {
    let redactor = Redactor::new(&context(&[]));
    let grant = format!(
        "eyJ2IjoyLCJraWQiOiJrMSIsImtpbmQiOiJkZXZpY2UifQ.{}",
        "s".repeat(86)
    );
    let safe = redactor.diagnostic(&format!("hello {grant} via ace.grant.{grant}"));
    assert!(!safe.contains(&grant), "{safe}");
    let record = redactor.diagnostic(
        r#"{"type":"account.standing","grant":"anything-at-all","proof":"pppppppppp","personGrant":"secret-ish","standing":"also-secret","grantTtlMs":300000}"#,
    );
    for secret in ["anything-at-all", "pppp", "secret-ish", "also-secret"] {
        assert!(!record.contains(secret), "{record}");
    }
    assert!(record.contains("300000"), "{record}");
}

// consumed-openers.test.ts
#[test]
fn an_unquoted_backslash_cannot_hide_a_consumed_credential_container_opener() {
    let redactor = Redactor::new(&context(&[("CUSTOM", "lead\\{")]));
    let evidence = "lead\\{\"credentials\":{\"login\":\"OPAQUE_CONTAINER_CREDENTIAL\"},\"code\":7}";
    for input in [
        evidence.to_owned(),
        quoted(evidence),
        format!(r#"{{"stderr":{}}}"#, quoted(evidence)),
    ] {
        let safe = redactor.diagnostic(&input);
        assert!(!safe.contains("OPAQUE_CONTAINER_CREDENTIAL"), "{safe}");
        assert!(safe.contains("<ENV>"), "{safe}");
    }
}

#[test]
fn quoted_backslashes_and_braces_do_not_consume_unrelated_diagnostic_records() {
    let redactor = Redactor::new(&context(&[("CUSTOM", "lead\\{")]));
    let input = "before \"lead\\\\{ harmless\" {\"code\":7} after";
    let safe = redactor.diagnostic(input);
    assert!(safe.contains("<ENV> harmless"), "{safe}");
    assert!(safe.contains("\"code\":7"), "{safe}");
    assert!(safe.contains("after"), "{safe}");
}

// embedded-performance.test.ts
#[test]
fn omitting_a_record_with_thousands_of_contained_secret_prefixes_stays_bounded() {
    let redactor = Redactor::new(&context(&[("FIRST", "lead{"), ("SECOND", "[xxx")]));
    let input = format!("lead{{\"note\":\"{}\"}} after", "[xxx ".repeat(12_000));
    for _ in 0..4 {
        assert_eq!(redactor.diagnostic(&input), "<ENV> after");
    }
}
