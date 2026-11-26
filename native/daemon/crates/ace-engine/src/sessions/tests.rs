// SPDX-License-Identifier: Apache-2.0
//! The moved cases: `agent-env.test.ts` (2) and the pure halves of
//! `open-failure.process.test.ts` (structured failures, refused CLI, unavailable model, Git fence)
//! plus `provider-errors.ts`'s readable copies.

use super::env::agent_session_env;
use super::errors::{shape_provider_error, structured_error};
use super::failure_copy::{failed_action_title, failure_reason, retained_failure};
use super::open::{SessionOpenRoute, unavailable_native_history};
use ace_json::Value;

fn text(value: &str) -> Value {
    Value::from(value)
}

fn object(fields: &[(&str, Value)]) -> Value {
    let mut map = ace_json::Map::new();
    for (key, value) in fields {
        map.insert(*key, value.clone());
    }
    Value::Object(map)
}

#[test]
fn an_agent_sessions_shell_names_its_own_thread_never_prompts_and_finds_its_daemons_home() {
    // agent-env.test.ts: "an agent session's shell names its own thread, never prompts, and finds
    // its daemon's home".
    assert_eq!(
        agent_session_env(&"t_9f2c41aa".to_owned(), Some("/home/a/.ace")),
        [
            ("ACE_THREAD_ID".to_owned(), "t_9f2c41aa".to_owned()),
            ("ACE_NO_INPUT".to_owned(), "1".to_owned()),
            ("ACE_HOME".to_owned(), "/home/a/.ace".to_owned()),
        ]
    );
}

#[test]
fn without_a_known_home_the_session_still_gets_its_thread_and_no_input() {
    // agent-env.test.ts: "without a known home the session still gets its thread and no-input".
    let env = agent_session_env(&"t_9f2c41aa".to_owned(), None);
    assert_eq!(env.len(), 2);
    assert_eq!(env[0].0, "ACE_THREAD_ID");
    assert!(!env.iter().any(|(name, _)| name == "ACE_HOME"));
}

#[test]
fn structured_open_failures_reach_diagnostics_and_notices_with_the_same_redacted_detail() {
    // open-failure.process.test.ts: "structured open failures reach diagnostics and stored
    // notices with the same redacted detail".
    let error = object(&[
        ("kind", text("provider")),
        (
            "message",
            text("[claude:authentication_failed] native text"),
        ),
        ("detail", text("native text")),
    ]);
    let shaped = structured_error(error, "claude", None);
    assert_eq!(
        shaped.get("message").and_then(Value::as_str),
        Some("Claude could not authenticate. Sign in again using the provider's own CLI.")
    );
    assert_eq!(
        shaped.get("code").and_then(Value::as_str),
        Some("authentication_failed")
    );
    assert_eq!(
        shaped.get("title").and_then(Value::as_str),
        Some("Not signed in to Claude Code")
    );
    assert_eq!(
        shaped.get("detail").and_then(Value::as_str),
        Some("native text")
    );
    let details = shaped.get("details").expect("details");
    assert_eq!(
        details.get("provider").and_then(Value::as_str),
        Some("claude")
    );

    // A notice's readable copy keeps the native text in raw, once.
    let notice = object(&[
        ("type", text("item.upsert")),
        ("agent", text("root")),
        (
            "draft",
            object(&[
                ("type", text("notice")),
                ("level", text("error")),
                (
                    "text",
                    text("[cursor:model_not_found] {\"model\":\"sonnet\"}"),
                ),
            ]),
        ),
    ]);
    let shaped = shape_provider_error(notice, "cursor", None);
    let draft = shaped.get("draft").expect("draft");
    assert_eq!(
        draft.get("text").and_then(Value::as_str),
        Some(
            "Cursor could not use the selected model \"sonnet\". Choose an available model or check this account's model access."
        )
    );
    assert_eq!(
        draft.get("code").and_then(Value::as_str),
        Some("model_not_found")
    );
    assert_eq!(
        draft
            .get("details")
            .and_then(|details| details.get("model"))
            .and_then(Value::as_str),
        Some("sonnet"),
        "the model the tag named survives into the notice's details"
    );
    let raw = draft.get("raw").and_then(Value::as_array).expect("raw");
    assert_eq!(raw.len(), 1);
    assert_eq!(
        raw[0].get("type").and_then(Value::as_str),
        Some("provider.error")
    );
}

#[test]
fn a_cli_version_ace_refuses_holds_the_message_under_that_reason() {
    // open-failure.process.test.ts: "a CLI version ace refuses holds the message under that
    // reason, not a connection hint".
    let details = object(&[
        ("code", text("cli_unsupported")),
        (
            "detail",
            text("claude 2.0 is older than this ace needs\nmore"),
        ),
    ]);
    let (code, title) = retained_failure("could not start", false, Some(&details));
    assert_eq!(code, "cli_unsupported");
    assert_eq!(title, "claude 2.0 is older than this ace needs");
}

#[test]
fn an_unavailable_model_and_a_git_fence_keep_the_send_with_their_own_reasons() {
    // open-failure.process.test.ts: "an unavailable model holds the original input until a model
    // switch sends it once" and "a send Git's cleanup fence stopped is kept as fenced, with the
    // fence's plain-words reason".
    let (code, title) = retained_failure("model_unavailable", true, None);
    assert_eq!(code, "model_unavailable");
    assert!(title.contains("Choose another model"));
    let details = object(&[("code", text("git_quarantined"))]);
    let (code, title) = retained_failure("git says no", false, Some(&details));
    assert_eq!(code, "git_quarantined");
    assert!(title.contains("clear the stale lock"));
    let (code, _) = retained_failure("delivery failed", false, None);
    assert_eq!(code, "delivery_failed");
    let (_, title) = retained_failure(
        "Context preparation is unavailable for this thread",
        false,
        None,
    );
    assert!(title.contains("attachments could not be prepared"));
}

#[test]
fn a_failure_reason_is_its_first_line_cut_at_159_utf16_units() {
    let (_, title) = retained_failure("", false, None);
    assert!(!title.is_empty());
    assert_eq!(
        failure_reason("\n  first line \nsecond").to_string_lossy(),
        "first line"
    );
    // 160 code points of an astral character are 320 UTF-16 units: the cut is at 159 units, as
    // TypeScript's `.slice(0, 159)` counts them (rule 17), and ends with the ellipsis.
    let long = "\u{1f600}".repeat(200);
    let reason = failure_reason(&long);
    assert_eq!(reason.len_utf16(), 160);
    assert!(reason.as_str().ends_with('\u{2026}'));
}

#[test]
fn a_failed_requests_title_names_what_the_person_asked_for() {
    assert_eq!(
        failed_action_title("thread.interrupt"),
        "Couldn't stop the agent"
    );
    assert_eq!(
        failed_action_title("background_task.stop"),
        "Couldn't stop the background task"
    );
    assert_eq!(failed_action_title("unknown"), "Couldn't finish that");
}

#[test]
fn only_provider_evidence_about_the_native_conversation_justifies_unavailable_history() {
    // open-failure.process.test.ts: the resume guidance only follows the provider's own evidence.
    assert!(unavailable_native_history("resume_unavailable", ""));
    assert!(unavailable_native_history("conversation_not_found", ""));
    assert!(unavailable_native_history(
        "session_open_failed",
        "No conversation found with id abc"
    ));
    assert!(!unavailable_native_history(
        "session_open_failed",
        "No conversation found2"
    ));
    assert!(!unavailable_native_history(
        "session_open_failed",
        "spawn failed"
    ));
}

#[test]
fn the_open_route_carries_only_local_diagnostics() {
    let route = SessionOpenRoute {
        model: Some("model".to_owned()),
        instance: Some("instance".to_owned()),
        backend: Some("acp".to_owned()),
    };
    let json = ace_json::to_string(&route.to_json());
    assert_eq!(
        json,
        "{\"model\":\"model\",\"instance\":\"instance\",\"backend\":\"acp\"}"
    );
    assert_eq!(
        ace_json::to_string(&SessionOpenRoute::default().to_json()),
        "{}"
    );
}
