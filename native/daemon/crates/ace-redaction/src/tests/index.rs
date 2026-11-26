// SPDX-License-Identifier: Apache-2.0
//! `index.test.ts` plus its file-URL, fragment and wrapper cases (from `packages/redaction/src`).

use super::*;

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
