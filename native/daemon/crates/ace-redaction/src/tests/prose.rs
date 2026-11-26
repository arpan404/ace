// SPDX-License-Identifier: Apache-2.0
//! `quoted-passwords.test.ts`, `credential-overlap.test.ts`, `ambiguous-assignments.test.ts` and `damaged-keys.test.ts`.

use super::*;

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
