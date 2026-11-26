// SPDX-License-Identifier: Apache-2.0
//! The shell's own tests: what one input and the terminal barrier make of a wire with no child.

use super::*;
use ace_adapter_api::frame::FrameDirection;

fn core() -> ClaudeSessionCore {
    ClaudeSessionCore::new(WireConfig {
        session_id: "session-1".to_owned(),
        root_key: "root".to_owned(),
        bearer: None,
        resume: false,
    })
}

fn clean_exit() -> RawExit {
    RawExit {
        code: Some(0),
        signal: None,
    }
}

/// The barrier frames the final line with no newline, byte for byte, before `Drained`: a
/// finish that only pushed `Drained` would lose it.
#[test]
fn the_barrier_frames_a_final_line_before_drained() {
    let core = core();
    let line = r#"{"type":"keep_alive"}"#;
    core.input(|wire| wire.stdout_bytes(line.as_bytes()));
    OutputConsumer::close(&core, clean_exit());
    let events = core.queue().take_batch(256, 256 * 1024);
    let tail = events.iter().position(|event| {
        matches!(event,
                SessionEvent::Frame { dir: FrameDirection::Recv, channel, text, .. }
                    if channel == "sdk" && text == line)
    });
    assert!(
        tail.is_some(),
        "the final line is framed as the CLI wrote it"
    );
    assert_eq!(
        events
            .iter()
            .position(|event| matches!(event, SessionEvent::Drained)),
        Some(events.len() - 1),
        "Drained comes after the tail line"
    );
}

/// A line over the byte bound fails the session with the capture's own message, and the
/// barrier still drains after it.
#[test]
fn a_fatal_names_the_byte_bound_and_drained_follows_it() {
    let core = core();
    let huge = format!(
        r#"{{"type":"keep_alive","data":"{}"}}"#,
        " ".repeat(1024 * 1024)
    );
    core.input(|wire| wire.stdout_bytes(format!("{huge}\n").as_bytes()));
    OutputConsumer::close(&core, clean_exit());
    let events = core.queue().take_batch(512, 1024 * 1024);
    assert!(
        events.iter().any(|event| matches!(
            event,
            SessionEvent::Fatal { message }
                if message == "RangeError: Provider payload exceeds byte limit"
        )),
        "the capture's message is the failure"
    );
    assert_eq!(
        events
            .iter()
            .position(|event| matches!(event, SessionEvent::Drained)),
        Some(events.len() - 1),
        "Drained comes last"
    );
}

/// The session's own variables are the last word on the child's environment.
#[test]
fn the_session_owns_its_two_variables_and_leaves_the_rest_alone() {
    let base = vec![
        ("PATH".to_owned(), "/usr/bin".to_owned()),
        (
            "CLAUDE_CODE_SDK_READS_SESSION_STATE".to_owned(),
            "0".to_owned(),
        ),
        ("HOME".to_owned(), "/home/person".to_owned()),
    ];
    let env = session_env(base);
    assert_eq!(
        env,
        vec![
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("HOME".to_owned(), "/home/person".to_owned()),
            (
                "CLAUDE_AGENT_SDK_CLIENT_APP".to_owned(),
                "ace/0.0.0".to_owned()
            ),
            (
                "CLAUDE_CODE_SDK_READS_SESSION_STATE".to_owned(),
                "1".to_owned()
            ),
        ]
    );
}

/// A failure's text wins over the process's own end (`session.ts:257`-`:268`).
#[test]
fn a_recorded_failure_is_the_exit_message() {
    assert_eq!(
        exit_message(
            Some("Claude session state is unreadable"),
            &clean_exit(),
            None
        ),
        "Claude session state is unreadable"
    );
}

/// Without a failure the exit reports its code, else its signal, else the shell's reason.
#[test]
fn the_exit_message_reports_the_code_then_the_signal_then_the_reason() {
    let signalled = RawExit {
        code: None,
        signal: Some("SIGTERM".to_owned()),
    };
    let silent = RawExit {
        code: None,
        signal: None,
    };
    assert_eq!(
        exit_message(None, &clean_exit(), Some("stopped")),
        "Claude process exited: 0"
    );
    assert_eq!(
        exit_message(None, &signalled, Some("stopped")),
        "Claude process exited: SIGTERM"
    );
    assert_eq!(
        exit_message(None, &silent, Some("output-limit")),
        "Claude process exited: output-limit"
    );
}

/// A stop with no target is the TS's no-agent branch: every live task, certain
/// (`session.ts:457`-`:460`).
#[test]
fn a_cascade_with_no_target_names_every_live_task() {
    let core = core();
    core.input(|wire| {
            wire.stdout_bytes(
                br#"{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"tool-1"}
"#,
            )
        });
    assert_eq!(
        core.task_cascade(None),
        r#"{"ids":["task-1"],"uncertain":false}"#
    );
    core.input(|wire| {
            wire.stdout_bytes(
                br#"{"type":"system","subtype":"task_started","task_id":"task-2","tool_use_id":"tool-2"}
"#,
            )
        });
    assert_eq!(
        core.task_cascade(None),
        r#"{"ids":["task-1","task-2"],"uncertain":false}"#
    );
    core.input(|wire| {
            wire.stdout_bytes(
                br#"{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed"}
"#,
            )
        });
    assert_eq!(
        core.task_cascade(None),
        r#"{"ids":["task-2"],"uncertain":false}"#
    );
}
