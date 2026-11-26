// SPDX-License-Identifier: Apache-2.0
//! `sdk-counters.test.ts`, `provider-api-key.test.ts` and `json-credentials.test.ts`.

use super::*;

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
