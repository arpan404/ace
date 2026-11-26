// SPDX-License-Identifier: Apache-2.0
//! `diagnostic.test.ts`, `consumed-openers.test.ts` and `embedded-performance.test.ts`.

use super::*;

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
