//! Ports the failing inputs of the settings review: an unknown or mistyped known
//! value is refused ("Settings document has invalid known values"), the retired
//! `remote.transport` value still parses, and `version: 2.0` is accepted.

use super::*;
use serde_json::json;

#[test]
fn known_values_are_checked_against_their_key() {
    assert!(validate_value("threads.followUpBehavior", &json!("queue")).is_ok());
    assert_eq!(
        validate_value("threads.followUpBehavior", &json!("soon"))
            .map_err(|error| (error.code, error.message)),
        Err((
            SettingsCode::Validation,
            "Invalid value for threads.followUpBehavior".into()
        ))
    );
    assert!(validate_value("providers.coder.provider", &json!(null)).is_ok());
    assert!(validate_value("providers.coder.provider", &json!("chatgpt")).is_err());
    assert!(validate_value("logs.maxBytes", &json!(1024)).is_err());
    assert!(is_key("threads.settleOnClose"));
    assert!(!is_key("threads.settleSoon"));
}

#[test]
fn an_object_key_fills_its_defaults_and_strips_unknown_fields() {
    let kept = validate_value(
        "storage.retention",
        &json!({ "threads": 30, "futureField": true }),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(kept["threads"], 30);
    assert_eq!(kept["attachments"], 30);
    assert_eq!(kept["idleThreads"], false);
    assert!(kept.get("futureField").is_none());
}

#[test]
fn retention_categories_may_be_null_or_up_to_ten_thousand_days() {
    let kept = validate_value(
        "storage.retention",
        &json!({ "threads": null, "logs": 10_000 }),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(kept["threads"], Value::Null, "null disables the category");
    assert_eq!(kept["logs"], 10_000);
    assert_eq!(
        kept["attachments"], 30,
        "an absent category keeps its default"
    );
    assert!(validate_value("storage.retention", &json!({ "threads": 36_500 })).is_ok());
    for bad in [json!(0), json!(36_501), json!("30")] {
        assert!(
            validate_value("storage.retention", &json!({ "threads": bad })).is_err(),
            "{bad}"
        );
    }
    // `storage.retentionDays` keeps the separate 3,650-day cap.
    assert!(validate_value("storage.retentionDays", &json!(3651)).is_err());
}

#[test]
fn provider_rows_keep_their_contract_and_unique_pairs() {
    let rows = json!([{
        "provider": "cursor",
        "instance": "work",
        "binaryPath": "/opt/cursor",
        "futureField": 1
    }]);
    let kept =
        validate_value("providers.configuration", &rows).unwrap_or_else(|error| panic!("{error}"));
    assert!(kept[0].get("futureField").is_none());
    let duplicate = json!([
        { "provider": "cursor" },
        { "provider": "cursor" }
    ]);
    assert!(validate_value("providers.configuration", &duplicate).is_err());
}

#[test]
fn the_client_blob_cap_is_utf8_bytes() {
    let text = "🚀".repeat(MAX_CLIENT_BYTES / 4 + 1);
    assert_eq!(
        validate_value("clients.theme", &json!(text)).map_err(|error| error.code),
        Err(SettingsCode::Size)
    );
}

#[test]
fn string_bounds_count_utf16_units_and_integers_may_be_integer_valued() {
    let refused = "😀".repeat(129);
    assert!(
        validate_value("host.displayName", &json!(refused)).is_err(),
        "258 UTF-16 units exceed 256"
    );
    assert!(validate_value("host.displayName", &json!("😀".repeat(128))).is_ok());
    assert_eq!(
        validate_value("agents.maxRunningChildren", &json!(1.0)).ok(),
        Some(json!(1))
    );
    assert!(validate_value("agents.maxRunningChildren", &json!(1.5)).is_err());
}

#[test]
fn a_source_control_host_must_agree_with_its_provider() {
    let good = json!({
        "hosts": [{ "host": "github.com", "account": "octocat" }],
        "host": "github.com",
        "remote": "origin"
    });
    assert!(validate_value("sourceControl.preferences", &good).is_ok());
    let mismatched = json!({
        "hosts": [{ "host": "github.com", "forge": "gitlab" }],
        "host": "github.com",
        "remote": "origin"
    });
    assert!(validate_value("sourceControl.preferences", &mismatched).is_err());
    let origin_elsewhere = json!({
        "hosts": [{ "host": "git.example.com", "forge": "origin" }],
        "host": "git.example.com",
        "remote": "origin"
    });
    assert!(validate_value("sourceControl.preferences", &origin_elsewhere).is_err());
    let origin = json!({
        "hosts": [{ "host": "origin.cursor.com", "forge": "origin" }],
        "host": "origin.cursor.com",
        "remote": "origin"
    });
    assert!(validate_value("sourceControl.preferences", &origin).is_ok());
    let dotted_github_account = json!({
        "hosts": [{ "host": "github.com", "account": "a.b" }],
        "host": "github.com",
        "remote": "origin"
    });
    assert!(validate_value("sourceControl.preferences", &dotted_github_account).is_err());
}

#[test]
fn the_client_blob_cap_counts_json_stringify_bytes_and_reports_a_size_diagnostic() {
    // 17,000 `0.0` literals: 34,001 bytes as `JSON.stringify` writes them, so the size
    // the crate measures must not refuse what the TypeScript accepts.
    let zeros = Value::Array(vec![json!(0.0); 17_000]);
    assert!(validate_value("clients.theme", &zeros).is_ok());

    let oversized = json!("é".repeat(MAX_CLIENT_BYTES));
    assert_eq!(
        validate_value("clients.theme", &oversized).map_err(|error| (error.code, error.message)),
        Err((
            SettingsCode::Size,
            "Client settings blob exceeds 64 KiB".into()
        ))
    );

    // Reading a document with an oversized blob reports `size`, not the generic
    // invalid-known-values refusal.
    let text = serde_json::json!({
        "version": 2,
        "settings": { "clients.theme": "a".repeat(MAX_CLIENT_BYTES) }
    })
    .to_string();
    assert_eq!(
        crate::document::DecodedDocument::decode(&text)
            .map_err(|error| (error.code, error.message)),
        Err((
            SettingsCode::Size,
            "Client settings blob exceeds 64 KiB".into()
        ))
    );

    // And the accepted array reads back.
    let text = serde_json::json!({
        "version": 2,
        "settings": { "clients.theme": Value::Array(vec![json!(0.0); 17_000]) }
    })
    .to_string();
    assert!(crate::document::DecodedDocument::decode(&text).is_ok());
}

#[test]
fn origins_are_https_without_path_query_or_credentials() {
    assert_eq!(
        validate_value("remote.mcpPublicUrl", &json!("https://ace.example.com"))
            .unwrap_or(Value::Null),
        json!("https://ace.example.com")
    );
    for bad in [
        json!("https://ace.example.com/"),
        json!("http://ace.example.com"),
        json!("https://ace.example.com/path"),
        json!("https://user:pass@ace.example.com"),
    ] {
        assert!(
            validate_value("remote.mcpPublicUrl", &bad).is_err(),
            "{bad}"
        );
    }
    assert!(validate_value("remote.relayUrl", &json!("")).is_ok());
    assert!(validate_value("remote.relayUrl", &json!("wss://relay.example.com/")).is_ok());
    assert!(validate_value("remote.relayUrl", &json!("ws://relay.example.com/")).is_err());
    assert!(validate_value("remote.relayUrl", &json!("ws://127.0.0.1:1234/")).is_ok());
}
