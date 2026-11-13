use serde_json::json;

use super::*;
use crate::event::{Call, Tokens};

fn k(known: Known) -> Event {
    Event::Known(known)
}

fn started(reply: &str) -> Event {
    Event::reply_started(reply, "m")
}

fn finished(reply: &str) -> Event {
    k(Known::ReplyFinished {
        reply: reply.into(),
        text: String::new(),
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    })
}

fn step(reply: &str, calls: Vec<(&str, serde_json::Value)>) -> Event {
    k(Known::StepFinished {
        reply: reply.into(),
        text: String::new(),
        calls: calls
            .into_iter()
            .enumerate()
            .map(|(n, (name, arguments))| Call {
                id: format!("{reply}-{n}"),
                name: name.into(),
                arguments,
            })
            .collect(),
        thoughts: Vec::new(),
        usage: Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

fn status(word: &str) -> (&'static str, serde_json::Value) {
    (TASK_STATUS, json!({ "status": word }))
}

fn wrote(reply: &str) -> Event {
    k(Known::ToolStarted {
        reply: reply.into(),
        call_id: format!("{reply}-w"),
        name: "workspace_write".into(),
        risk: Some(Risk::Write),
        background: false,
    })
}

fn continued(step: u32) -> Event {
    k(Known::TaskContinued {
        step,
        nudge: nudge(step),
    })
}

/// A person's turn that left the task working.
fn opened() -> Vec<Event> {
    vec![
        Event::user_message("Port the tests"),
        started("r0"),
        step("r0", vec![status("working")]),
        step("r0", vec![]),
        finished("r0"),
    ]
}

/// Adds a continued step `n` that wrote something (or not).
fn add(events: &mut Vec<Event>, n: u32, effect: bool) {
    let reply = format!("r{n}");
    events.push(continued(n));
    events.push(started(&reply));
    if effect {
        events.push(step(&reply, vec![("workspace_write", json!({}))]));
        events.push(wrote(&reply));
    }
    events.push(step(&reply, vec![]));
    events.push(finished(&reply));
}

#[test]
fn a_task_left_working_continues_at_once_and_counts_its_steps() {
    let mut events = opened();
    assert_eq!(
        next(&events, &Policy::default()),
        Next::Continue {
            step: 1,
            after_ms: 0
        }
    );
    add(&mut events, 1, true);
    assert_eq!(
        next(&events, &Policy::default()),
        Next::Continue {
            step: 2,
            after_ms: 0
        }
    );
}

#[test]
fn nothing_continues_unless_the_task_is_working_and_the_reply_finished() {
    let none = vec![Event::user_message("hi"), started("r0"), finished("r0")];
    assert_eq!(next(&none, &Policy::default()), Next::Nothing);
    for word in ["done", "waiting", "blocked_on_person"] {
        let mut events = opened();
        events.push(Event::user_message("and?"));
        events.push(started("r1"));
        events.push(step("r1", vec![status(word)]));
        events.push(finished("r1"));
        assert_eq!(next(&events, &Policy::default()), Next::Nothing, "{word}");
    }
    let mut stopped = opened();
    stopped.pop();
    stopped.push(k(Known::ReplyStopped {
        reply: "r0".into(),
        text: String::new(),
    }));
    assert_eq!(next(&stopped, &Policy::default()), Next::Nothing);
    // Stop pressed while a step waited to start.
    let mut idle_stop = opened();
    idle_stop.push(k(Known::StopRequested {
        reply: None,
        jobs: Vec::new(),
    }));
    assert_eq!(next(&idle_stop, &Policy::default()), Next::Nothing);
    let mut open = opened();
    open.push(started("r9"));
    assert_eq!(next(&open, &Policy::default()), Next::Nothing);
}

#[test]
fn steps_that_change_nothing_back_off_then_pause() {
    let policy = Policy::default();
    let mut events = opened();
    add(&mut events, 1, false);
    assert_eq!(
        next(&events, &policy),
        Next::Continue {
            step: 2,
            after_ms: 30_000
        }
    );
    add(&mut events, 2, false);
    assert_eq!(
        next(&events, &policy),
        Next::Continue {
            step: 3,
            after_ms: 60_000
        }
    );
    add(&mut events, 3, false);
    assert_eq!(
        next(&events, &policy),
        Next::Pause {
            reason: PauseReason::NoProgress,
            steps: 3
        }
    );
    events.push(k(Known::TaskPaused {
        reason: PauseReason::NoProgress,
        steps: 3,
    }));
    assert_eq!(next(&events, &policy), Next::Nothing, "said once");
}

#[test]
fn a_changed_plan_counts_as_progress() {
    let mut events = opened();
    events.push(continued(1));
    events.push(started("r1"));
    events.push(step(
        "r1",
        vec![("todo", json!({ "items": [{ "text": "a" }] }))],
    ));
    events.push(finished("r1"));
    assert_eq!(
        next(&events, &Policy::default()),
        Next::Continue {
            step: 2,
            after_ms: 0
        }
    );
    // The same plan again is no progress.
    events.push(continued(2));
    events.push(started("r2"));
    events.push(step(
        "r2",
        vec![("todo", json!({ "items": [{ "text": "a" }] }))],
    ));
    events.push(finished("r2"));
    assert!(matches!(
        next(&events, &Policy::default()),
        Next::Continue {
            after_ms: 30_000,
            ..
        }
    ));
}

#[test]
fn a_task_pauses_at_its_step_budget_and_a_message_starts_afresh() {
    let policy = Policy {
        max_steps: 2,
        ..Policy::default()
    };
    let mut events = opened();
    add(&mut events, 1, true);
    add(&mut events, 2, true);
    assert_eq!(
        next(&events, &policy),
        Next::Pause {
            reason: PauseReason::Budget,
            steps: 2
        }
    );
    events.push(Event::user_message("keep going"));
    events.push(started("r3"));
    events.push(step("r3", vec![]));
    events.push(finished("r3"));
    assert_eq!(
        next(&events, &policy),
        Next::Continue {
            step: 1,
            after_ms: 0
        }
    );
}

#[test]
fn the_task_state_is_the_latest_valid_task_status_call() {
    let mut events = opened();
    events.push(step(
        "r0",
        vec![(TASK_STATUS, json!({ "status": "nonsense" }))],
    ));
    assert_eq!(state(&events).map(|s| s.status), Some(Status::Working));
    events.push(step(
        "r0",
        vec![(
            "call_tool",
            json!({ "name": TASK_STATUS, "arguments": { "status": "done", "note": "all green" } }),
        )],
    ));
    assert_eq!(
        state(&events),
        Some(State {
            status: Status::Done,
            note: Some("all green".into())
        })
    );
}

#[test]
fn a_routine_firing_keeps_the_tasks_budget_and_its_pause() {
    use crate::event::FromRoutine;
    let policy = Policy {
        max_steps: 1,
        ..Policy::default()
    };
    let mut events = opened();
    add(&mut events, 1, true);
    events.push(k(Known::TaskPaused {
        reason: PauseReason::Budget,
        steps: 1,
    }));
    events.push(k(Known::UserMessage {
        text: "Check the build".into(),
        context: None,
        images: Vec::new(),
        documents: Vec::new(),
        voice: None,
        from_agent: None,
        from_routine: Some(Box::new(FromRoutine {
            id: "rt1".into(),
            name: "Check".into(),
            run: "run1".into(),
            label: "9:00".into(),
            heartbeat: false,
            event: None,
            untrusted: false,
        })),
        from_group: None,
    }));
    events.push(started("r9"));
    events.push(step("r9", vec![]));
    events.push(finished("r9"));
    assert_eq!(next(&events, &policy), Next::Nothing, "still paused");
}
