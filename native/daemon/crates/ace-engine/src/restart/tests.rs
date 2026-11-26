// SPDX-License-Identifier: Apache-2.0
//! The restart rules and the two ledgers, over a decoded state and an in-memory store.

use super::*;
use ace_core::state::{AgentRecord, CoreConfig, create_thread_state};
use ace_store::{Connection, OpenOptions};

fn state() -> ThreadState {
    create_thread_state(
        "thread-1".to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 100.0,
            liveness: None,
        },
    )
    .unwrap()
}

fn record(json: &str) -> AgentRecord {
    serde_json::from_str(json).unwrap()
}

fn run(state: &mut ThreadState) {
    state.runs.insert(
        "run-1".to_owned(),
        serde_json::from_str(
            r#"{"id":"run-1","threadId":"thread-1","agentId":"agent-root","trigger":"user","seq":1,"state":"active","startedAt":1}"#,
        )
        .unwrap(),
    );
}

fn task(state: &mut ThreadState, id: &str, status: &str, title: &str) {
    state.tasks.insert(
        id.to_owned(),
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","agentId":"agent-root","kind":"bash","title":"{title}","status":"{status}","ambient":false,"stoppable":true,"startedAt":1}}"#
        ))
        .unwrap(),
    );
    state.indexes.running_tasks.insert(id.to_owned(), true);
}

fn agent(state: &mut ThreadState, key: &str, json: &str) {
    state.agents.insert(key.to_owned(), record(json));
}

fn database() -> Arc<Connection> {
    let conn = Connection::open(
        ":memory:",
        OpenOptions {
            read_only: false,
            timeout_ms: 0,
        },
    )
    .unwrap();
    conn.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)")
        .unwrap();
    conn.exec("INSERT INTO threads(id) VALUES ('thread-1')")
        .unwrap();
    ensure_ledgers(&conn).unwrap();
    conn
}

#[test]
fn nothing_is_lost_without_a_run() {
    let mut state = state();
    task(&mut state, "tool-1", "running", "npm test");
    state.queue_sources.provider = 1;
    assert_eq!(lost_work_lines(&state, 0, 10), None);
}

#[test]
fn a_running_task_and_the_provider_queue_are_named() {
    let mut state = state();
    run(&mut state);
    task(&mut state, "tool-1", "running", "npm test");
    state.queue_sources.provider = 1;
    assert_eq!(
        lost_work_lines(&state, 0, 10),
        Some(vec!["bash: npm test [tool-1]".to_owned()])
    );
}

#[test]
fn a_finished_task_is_not_named() {
    let mut state = state();
    run(&mut state);
    task(&mut state, "tool-1", "completed", "npm test");
    state.queue_sources.provider = 1;
    assert_eq!(lost_work_lines(&state, 0, 10), Some(Vec::new()));
}

#[test]
fn a_root_agent_mid_run_keeps_the_thread_live_and_a_subagent_is_named() {
    let mut state = state();
    run(&mut state);
    agent(
        &mut state,
        "root",
        r#"{"agent":{"id":"agent-root","threadId":"thread-1","origin":"root","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":1},"activity":"thinking","lastSignalAt":1,"activeRun":"run-1"}"#,
    );
    assert_eq!(
        lost_work_lines(&state, 0, 10),
        Some(Vec::new()),
        "live, but a root turn is not named"
    );
    agent(
        &mut state,
        "child",
        r#"{"agent":{"id":"agent-child","threadId":"thread-1","origin":"subagent","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":1,"name":"Reviewer"},"activity":"thinking","lastSignalAt":1}"#,
    );
    assert_eq!(
        lost_work_lines(&state, 0, 10),
        Some(vec!["subagent: Reviewer".to_owned()])
    );
}

#[test]
fn settled_subagents_and_an_external_one_leave_nothing_live() {
    let mut state = state();
    run(&mut state);
    agent(
        &mut state,
        "idle",
        r#"{"agent":{"id":"agent-idle","threadId":"thread-1","origin":"subagent","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":1},"activity":"idle","lastSignalAt":1}"#,
    );
    agent(
        &mut state,
        "external",
        r#"{"agent":{"id":"agent-ext","threadId":"thread-1","origin":"subagent","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":1},"activity":"thinking","lastSignalAt":1,"externalStatus":{"state":"needs_you","interactions":1}}"#,
    );
    assert_eq!(
        lost_work_lines(&state, 0, 10),
        None,
        "no turn, queue, wake, task or request is live"
    );
}

#[test]
fn an_open_request_alone_is_lost_work() {
    let mut state = state();
    run(&mut state);
    state
        .indexes
        .pending_interactions
        .insert("ask-1".to_owned(), true);
    state.interactions.insert(
        "ask-1".to_owned(),
        serde_json::from_str(
            r#"{"id":"ask-1","threadId":"thread-1","agentId":"agent-root","blocking":true,"request":{"kind":"question","questions":[{"id":"q","text":"Which branch?","options":[]}]},"state":"pending","createdAt":1}"#,
        )
        .unwrap(),
    );
    assert_eq!(lost_work_lines(&state, 0, 10), Some(Vec::new()));
}

#[test]
fn a_wake_window_that_has_passed_is_not_live() {
    let mut state = state();
    run(&mut state);
    agent(
        &mut state,
        "root",
        r#"{"agent":{"id":"agent-root","threadId":"thread-1","origin":"root","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":1},"activity":"idle","lastSignalAt":1,"wakeUntil":5}"#,
    );
    assert_eq!(lost_work_lines(&state, 0, 10), None);
    assert_eq!(lost_work_lines(&state, 0, 4), Some(Vec::new()));
}

#[test]
fn pending_native_input_keeps_the_thread_live() {
    let mut state = state();
    run(&mut state);
    assert_eq!(lost_work_lines(&state, 2, 10), Some(Vec::new()));
}

#[test]
fn the_message_names_the_provider_or_the_cursor_uncertainty() {
    let mut state = state();
    run(&mut state);
    task(&mut state, "tool-1", "running", "npm test");
    let provider = lost_work(&state, 0, Some("codex"), 10).unwrap();
    assert!(provider.starts_with("ace restarted. The previous provider process stopped."));
    assert!(provider.contains("died or became unreachable:"));
    assert!(provider.contains("bash: npm test [tool-1]"));
    let cursor = lost_work(&state, 0, Some("cursor-sdk"), 10).unwrap();
    assert!(cursor.starts_with("ace restarted. The previous Cursor SDK host is unavailable."));
    assert!(cursor.contains("The following background work is unresolved:"));
    assert!(cursor.contains("unresolved") || cursor.contains("uncertain"));
}

#[test]
fn a_live_thread_with_no_named_work_says_so() {
    let mut state = state();
    run(&mut state);
    state.queue_sources.provider = 1;
    assert!(
        lost_work(&state, 0, None, 10)
            .unwrap()
            .ends_with("No known background work was live.")
    );
}

#[test]
fn the_request_line_reads_the_first_non_blank_text_line() {
    let question: InteractionRequest = serde_json::from_str(
        r#"{"kind":"question","questions":[{"id":"q","text":"\n  Which branch?  \nMore","options":[]}]}"#,
    )
    .unwrap();
    assert_eq!(request_line(&question), "Which branch?");
    let approval: InteractionRequest =
        serde_json::from_str(r#"{"kind":"approval","title":"Run ls in /tmp","options":[]}"#)
            .unwrap();
    assert_eq!(request_line(&approval), "Run ls in /tmp");
    let plan: InteractionRequest =
        serde_json::from_str(r##"{"kind":"plan_review","markdown":"# Plan"}"##).unwrap();
    assert_eq!(request_line(&plan), "plan review");
    let browser: InteractionRequest = serde_json::from_str(
        r#"{"kind":"browser_help","tabId":"t","reason":"r","message":"m","title":"\n \n"}"#,
    )
    .unwrap();
    assert_eq!(request_line(&browser), "browser help");
}

#[test]
fn an_open_request_names_its_first_pending_ask() {
    let mut state = state();
    state
        .indexes
        .pending_interactions
        .insert("ask-1".to_owned(), true);
    state.interactions.insert(
        "ask-1".to_owned(),
        serde_json::from_str(
            r#"{"id":"ask-1","threadId":"thread-1","agentId":"agent-root","blocking":true,"request":{"kind":"question","questions":[{"id":"q","text":"Which branch?","options":[]}]},"state":"pending","createdAt":1}"#,
        )
        .unwrap(),
    );
    state
        .indexes
        .pending_interactions
        .insert("ask-2".to_owned(), true);
    state.interactions.insert(
        "ask-2".to_owned(),
        serde_json::from_str(
            r#"{"id":"ask-2","threadId":"thread-1","agentId":"agent-root","blocking":true,"request":{"kind":"approval","title":"Answered already","options":[]},"state":"resolved","createdAt":1}"#,
        )
        .unwrap(),
    );
    assert_eq!(open_request_line(&state), Some("Which branch?".to_owned()));
}

#[test]
fn the_restart_decision_continues_only_safe_interrupted_work() {
    let safe = RestartFacts {
        was_running: true,
        held_before: false,
        settled: false,
        archived: false,
        waiting_on_person: false,
        uncertain: false,
        can_continue: true,
        streak: 0,
    };
    assert_eq!(restart_decision(&safe), RestartDecision::Resume);
    for facts in [
        RestartFacts {
            was_running: false,
            ..safe
        },
        RestartFacts {
            held_before: true,
            ..safe
        },
        RestartFacts {
            settled: true,
            ..safe
        },
        RestartFacts {
            archived: true,
            ..safe
        },
    ] {
        assert_eq!(restart_decision(&facts), RestartDecision::None);
    }
    assert_eq!(
        restart_decision(&RestartFacts {
            waiting_on_person: true,
            ..safe
        }),
        RestartDecision::Hold(RestartHold::Person)
    );
    assert_eq!(
        restart_decision(&RestartFacts {
            uncertain: true,
            ..safe
        }),
        RestartDecision::Hold(RestartHold::Uncertain)
    );
    assert_eq!(
        restart_decision(&RestartFacts {
            can_continue: false,
            ..safe
        }),
        RestartDecision::Hold(RestartHold::Unsupported)
    );
    assert_eq!(
        restart_decision(&RestartFacts {
            streak: MAX_RESTART_RESUMES,
            ..safe
        }),
        RestartDecision::Hold(RestartHold::Loop)
    );
    assert_eq!(
        restart_decision(&RestartFacts {
            streak: MAX_RESTART_RESUMES - 1,
            ..safe
        }),
        RestartDecision::Resume
    );
}

#[test]
fn every_decision_has_its_notice() {
    assert_eq!(
        restart_notice_text(RestartDecision::Resume, None),
        "Interrupted by a restart. Continuing."
    );
    assert_eq!(
        restart_notice_text(
            RestartDecision::Hold(RestartHold::Person),
            Some("Which branch?")
        ),
        "Interrupted by a restart while waiting for your answer to \"Which branch?\". Continue \
         and the agent asks again."
    );
    assert_eq!(
        restart_notice_text(RestartDecision::Hold(RestartHold::Uncertain), None),
        "Interrupted by a restart while a message was being sent. Review it, then continue."
    );
    assert_eq!(
        restart_notice_text(RestartDecision::Hold(RestartHold::Unsupported), None),
        "Interrupted by a restart. This agent can't pick its session back up by itself; send a \
         message to carry on."
    );
    assert_eq!(
        restart_notice_text(RestartDecision::Hold(RestartHold::Loop), None),
        "Interrupted by a restart 3 times in a row, so ace stopped continuing it by itself. \
         Continue when ready."
    );
}

#[test]
fn the_continuation_names_the_stopped_work_and_at_most_64_lines() {
    let none = restart_continuation(&[]);
    assert!(none.contains("ace restarted while you were working"));
    assert!(!none.contains("These were running"));
    let lines: Vec<String> = (0..70).map(|index| format!("bash: task {index}")).collect();
    let text = restart_continuation(&lines);
    assert!(text.contains("bash: task 0"));
    assert!(text.contains("bash: task 63"));
    assert!(!text.contains("bash: task 64"), "at most 64 lines");
}

#[test]
fn both_messages_stay_inside_16384_units() {
    let lines: Vec<String> = (0..64).map(|_| "x".repeat(400)).collect();
    assert!(restart_continuation(&lines).encode_utf16().count() <= 16_384);
    let mut state = state();
    run(&mut state);
    for index in 0..64 {
        task(
            &mut state,
            &format!("tool-{index}"),
            "running",
            &"t".repeat(400),
        );
    }
    state.queue_sources.provider = 1;
    assert!(
        lost_work(&state, 0, None, 10)
            .unwrap()
            .encode_utf16()
            .count()
            <= 16_384
    );
}

#[test]
fn a_named_title_is_cut_at_160_units_without_splitting_a_character() {
    let mut state = state();
    run(&mut state);
    task(
        &mut state,
        &"i".repeat(200),
        "running",
        &format!("{}😀", "t".repeat(159)),
    );
    state.queue_sources.provider = 1;
    let line = lost_work_lines(&state, 0, 10).unwrap()[0].clone();
    assert!(
        line.starts_with(&format!("bash: {} [", "t".repeat(159))),
        "the emoji crossed the 160-unit bound: {line:?}"
    );
    assert!(!line.contains('😀'), "a cut never splits a character");
}

#[test]
fn a_restart_streak_counts_up_and_new_input_clears_it() {
    let conn = database();
    assert_eq!(streak(&conn, "thread-1").unwrap(), 0);
    assert_eq!(increment_streak(&conn, "thread-1").unwrap(), 1);
    assert_eq!(increment_streak(&conn, "thread-1").unwrap(), 2);
    assert_eq!(streak(&conn, "thread-1").unwrap(), 2);
    clear_streak(&conn, "thread-1").unwrap();
    assert_eq!(streak(&conn, "thread-1").unwrap(), 0);
}

#[test]
fn a_capture_is_read_once_and_then_gone() {
    let conn = database();
    assert!(!has_capture(&conn, "thread-1").unwrap());
    assert_eq!(take_capture(&conn, "thread-1").unwrap(), None);
    record_capture(
        &conn,
        "thread-1",
        &RestartCapture {
            waiting_on: Some("Which branch?".to_owned()),
        },
    )
    .unwrap();
    assert!(has_capture(&conn, "thread-1").unwrap());
    assert_eq!(
        take_capture(&conn, "thread-1").unwrap(),
        Some(RestartCapture {
            waiting_on: Some("Which branch?".to_owned())
        })
    );
    assert!(!has_capture(&conn, "thread-1").unwrap(), "read once");
}

#[test]
fn a_capture_without_a_wait_reads_back_as_none() {
    let conn = database();
    record_capture(&conn, "thread-1", &RestartCapture { waiting_on: None }).unwrap();
    assert_eq!(
        take_capture(&conn, "thread-1").unwrap(),
        Some(RestartCapture { waiting_on: None })
    );
    record_capture(
        &conn,
        "thread-1",
        &RestartCapture {
            waiting_on: Some("first".to_owned()),
        },
    )
    .unwrap();
    record_capture(
        &conn,
        "thread-1",
        &RestartCapture {
            waiting_on: Some("second".to_owned()),
        },
    )
    .unwrap();
    assert_eq!(
        take_capture(&conn, "thread-1").unwrap().unwrap().waiting_on,
        Some("second".to_owned()),
        "the newest capture wins"
    );
    record_capture(&conn, "thread-1", &RestartCapture { waiting_on: None }).unwrap();
    clear_capture(&conn, "thread-1").unwrap();
    assert!(!has_capture(&conn, "thread-1").unwrap());
}
