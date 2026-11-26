// SPDX-License-Identifier: Apache-2.0
//! The owned server's pure half (`owned-server.ts`): the spawn's arguments and
//! environment, the readiness line, and the authorization header.

use super::{ARGS, ReadinessError, basic_authorization, readiness, spawn_env};

fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn the_server_is_spawned_on_a_private_loopback_port() {
    assert_eq!(
        ARGS,
        ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]
    );
}

#[test]
fn the_environment_keeps_its_own_password_and_drops_every_credential() {
    let inherited = env(&[
        ("PATH", "/usr/bin"),
        ("ACE_MCP_TOKEN", "ace-token"),
        ("ACE_GRANT_KEY", "grant"),
        ("ACE_UNRELATED", "kept"),
        ("OPENCODE_PASSWORD", "old"),
        ("OPENCODE_SERVER_PASSWORD", "old"),
        ("OPENCODE_SERVER_USERNAME", "opencode"),
        ("HOME", "/home/me"),
    ]);
    let out = spawn_env(&inherited, "fresh");
    assert_eq!(
        out.get("OPENCODE_PASSWORD").map(String::as_str),
        Some("fresh")
    );
    assert_eq!(out.get("PATH").map(String::as_str), Some("/usr/bin"));
    assert_eq!(out.get("HOME").map(String::as_str), Some("/home/me"));
    // Only ace's credentials are dropped: another ACE_ variable is not one.
    assert_eq!(out.get("ACE_UNRELATED").map(String::as_str), Some("kept"));
    assert_eq!(out.get("ACE_MCP_TOKEN"), None);
    assert_eq!(out.get("ACE_GRANT_KEY"), None);
    assert_eq!(out.get("OPENCODE_SERVER_PASSWORD"), None);
    assert_eq!(out.get("OPENCODE_SERVER_USERNAME"), None);
    // The password keeps its inherited position, as a JS object spread does.
    let names: Vec<&str> = out.keys().map(String::as_str).collect();
    assert_eq!(
        names,
        ["PATH", "ACE_UNRELATED", "OPENCODE_PASSWORD", "HOME"]
    );
}

#[test]
fn the_authorization_is_the_password_base64_encoded() {
    // `Basic base64("opencode:" + password)`.
    assert_eq!(basic_authorization(""), "Basic b3BlbmNvZGU6");
    assert_eq!(
        basic_authorization("s3cret"),
        format!(
            "Basic {}",
            base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                "opencode:s3cret"
            )
        )
    );
    assert_eq!(basic_authorization("s3cret"), "Basic b3BlbmNvZGU6czNjcmV0");
}

#[test]
fn only_a_loopback_readiness_line_is_the_url() {
    assert_eq!(
        readiness(r#"{"url":"http://127.0.0.1:41234/"}"#),
        Ok(Some(String::from("http://127.0.0.1:41234/")))
    );
    assert_eq!(
        readiness(r#"{"url":"http://[::1]:41234/"}"#),
        Ok(Some(String::from("http://[::1]:41234/")))
    );
    // Other output is not the readiness line.
    for line in [
        "starting",
        "{}",
        r#"{"url":41234}"#,
        r#"{"url":null}"#,
        r#"["http://127.0.0.1:1/"]"#,
        "",
    ] {
        assert_eq!(readiness(line), Ok(None), "{line}");
    }
    // A URL the server must not be reached at is refused, not ignored.
    for line in [
        r#"{"url":"https://127.0.0.1:41234/"}"#,
        r#"{"url":"http://example.com:41234/"}"#,
        r#"{"url":"http://user:pass@127.0.0.1:41234/"}"#,
        r#"{"url":"http://127.0.0.1:41234/api"}"#,
        r#"{"url":"http://127.0.0.1:41234/?x=1"}"#,
        r#"{"url":"http://127.0.0.1/"}"#,
        r#"{"url":"http://127.0.0.1:65536/"}"#,
    ] {
        assert_eq!(readiness(line), Err(ReadinessError::InvalidUrl), "{line}");
    }
}
