// SPDX-License-Identifier: Apache-2.0
//! `args` against the recorded handshake argv and every pinned flag form.

use super::parse;
use crate::launch::{Launch, SessionStart, args};

const CODING_ARGV: &str =
    include_str!("../../../../../../fixtures/claude/handshake-2.1.331/argv.coding.json");
const ISOLATED_ARGV: &str =
    include_str!("../../../../../../fixtures/claude/handshake-2.1.331/argv.isolated.json");

/// The seven tokens the recording opens with: transport, then host permission prompts.
const PREFIX: [&str; 7] = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
];
/// The three flags the recording ends with.
const TAIL: [&str; 3] = [
    "--setting-sources=",
    "--include-hook-events",
    "--include-partial-messages",
];

fn recorded(text: &str) -> Vec<String> {
    let value = parse(text);
    let items = value.as_array().expect("the recorded argv is an array");
    items
        .iter()
        .map(|item| item.as_str().expect("an argv item is a string").to_owned())
        .collect()
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

/// ace's coding configuration, minus the flags each test adds.
fn launch() -> Launch {
    Launch {
        session: SessionStart::New {
            session_id: "session-1".to_owned(),
        },
        model: None,
        effort: None,
        permission_mode: None,
        allow_dangerously_skip_permissions: false,
        setting_sources: Some(Vec::new()),
        strict_mcp_config: false,
        mcp_config: None,
        plugin_dirs: Vec::new(),
        include_partial_messages: true,
        include_hook_events: true,
        extra: Vec::new(),
    }
}

#[test]
fn the_coding_configuration_matches_the_recorded_handshake_argv() {
    let mut expected = recorded(CODING_ARGV);
    expected.splice(7..7, ["--session-id".to_owned(), "session-1".to_owned()]);
    assert_eq!(args(&launch()), expected);
}

#[test]
fn the_isolated_configuration_matches_the_recorded_handshake_argv() {
    let mut isolated = launch();
    isolated.strict_mcp_config = true;
    let mut expected = recorded(ISOLATED_ARGV);
    expected.splice(7..7, ["--session-id".to_owned(), "session-1".to_owned()]);
    assert_eq!(args(&isolated), expected);
}

#[test]
fn each_session_start_writes_its_pinned_flag_forms() {
    let starts = [
        (
            SessionStart::New {
                session_id: "new".to_owned(),
            },
            vec!["--session-id", "new"],
        ),
        (
            SessionStart::Resume {
                session_id: "old".to_owned(),
            },
            vec!["--resume=old"],
        ),
        (
            SessionStart::Fork {
                source: "source".to_owned(),
                at: None,
                session_id: "forked".to_owned(),
            },
            vec![
                "--resume=source",
                "--fork-session",
                "--session-id",
                "forked",
            ],
        ),
        (
            SessionStart::Fork {
                source: "source".to_owned(),
                at: Some("turn".to_owned()),
                session_id: "forked".to_owned(),
            },
            vec![
                "--resume=source",
                "--fork-session",
                "--resume-session-at=turn",
                "--session-id",
                "forked",
            ],
        ),
    ];
    for (start, flags) in starts {
        let mut launch = launch();
        launch.session = start;
        let mut expected = owned(&PREFIX);
        expected.extend(owned(&flags));
        expected.extend(owned(&TAIL));
        assert_eq!(args(&launch), expected);
    }
}

#[test]
fn valued_options_keep_their_forms_and_the_order_the_brief_pins() {
    let mut launch = launch();
    launch.model = Some("claude-opus-5-5".to_owned());
    launch.effort = Some("high".to_owned());
    launch.permission_mode = Some("plan".to_owned());
    launch.allow_dangerously_skip_permissions = true;
    launch.setting_sources = Some(vec![
        "user".to_owned(),
        "project".to_owned(),
        "local".to_owned(),
    ]);
    launch.strict_mcp_config = true;
    launch.mcp_config = Some(r#"{"mcpServers":{}}"#.to_owned());
    launch.plugin_dirs = vec!["/one".to_owned(), "/two".to_owned()];
    launch.extra = vec![
        ("chrome".to_owned(), None),
        ("future".to_owned(), Some("on".to_owned())),
    ];
    let expected = vec![
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--session-id",
        "session-1",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--permission-mode",
        "plan",
        "--allow-dangerously-skip-permissions",
        "--setting-sources=user,project,local",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--plugin-dir",
        "/one",
        "--plugin-dir",
        "/two",
        "--include-hook-events",
        "--include-partial-messages",
        "--chrome",
        "--future=on",
    ];
    assert_eq!(args(&launch), owned(&expected));
}

#[test]
fn no_setting_sources_writes_no_flag() {
    let mut launch = launch();
    launch.setting_sources = None;
    assert!(
        !args(&launch)
            .iter()
            .any(|arg| arg.starts_with("--setting-sources"))
    );
}
