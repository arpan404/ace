use serde_json::{Value, json};

use super::*;

/// An event from its stored JSON, failing the test when Spade would not read it as known.
fn e(value: Value) -> Event {
    match Event::from_json(value.clone()) {
        Event::Known(known) => Event::Known(known),
        Event::Unknown(_) => panic!("not a known event: {value}"),
    }
}

fn link(budget: Option<u64>) -> Value {
    let mut made = json!({
        "type": "worker_of",
        "parent": "a1",
        "parent_conversation": "c1",
        "parent_name": "Lead",
        "call": "c1.call-1",
        "grants": { "tools": ["web_search"] },
        "brief": "Find the sources."
    });
    if let Some(budget) = budget {
        made["budget_micros"] = json!(budget);
    }
    made
}

fn started(reply: &str) -> Event {
    e(json!({ "type": "reply_started", "reply": reply, "model": "e/m" }))
}

fn finished(reply: &str, text: &str) -> Event {
    e(json!({ "type": "reply_finished", "reply": reply, "text": text, "cost_micros": 0 }))
}

fn brief() -> Event {
    Event::user_message("Find the sources.")
}

#[test]
fn a_worker_link_ignores_old_budgets_and_ends_when_detached() {
    // Budgets an earlier build stored (ADR 0161, removed by ADR 0166) still read.
    let mut events = vec![e(link(Some(2_000_000)))];
    let made = linked(&events).map(|l| l.parent);
    assert_eq!(made, Some("a1".to_owned()));
    events.push(Event::from_json(
        json!({ "type": "worker_budget", "budget_micros": 5_000_000, "by": "Lead" }),
    ));
    assert_eq!(linked(&events).map(|l| l.parent), Some("a1".to_owned()));
    events.push(e(json!({ "type": "worker_detached", "by": "person" })));
    assert_eq!(linked(&events), None, "a kept worker has no parent");
    assert_eq!(
        linked(&[brief()]),
        None,
        "a bot the person made is no worker"
    );
}

#[test]
fn a_worker_is_queued_until_its_brief_is_delivered() {
    let mut events = vec![e(link(None))];
    assert!(queued(&events));
    events.push(brief());
    assert!(!queued(&events));
    assert!(!queued(&[brief()]), "not a worker at all");
}

#[test]
fn a_worker_that_ended_its_turn_without_a_goal_reports_finished_with_its_words() {
    let events = vec![
        e(link(None)),
        brief(),
        started("r1"),
        finished("r1", "All found."),
    ];
    let report = settled(&events, Around::default()).map(|s| (s.state, s.epoch, s.words));
    assert_eq!(
        report,
        Some((
            ReportState::Finished,
            "r1".to_owned(),
            Some("All found.".to_owned())
        ))
    );
}

#[test]
fn a_worker_that_still_works_sleeps_or_carries_on_has_not_settled() {
    let open = vec![e(link(None)), brief(), started("r1")];
    assert_eq!(settled(&open, Around::default()), None, "reply open");
    let done = vec![e(link(None)), brief(), started("r1"), finished("r1", "x")];
    let cases = [
        Around {
            children_working: true,
            ..Around::default()
        },
        Around {
            carries_on: true,
            ..Around::default()
        },
    ];
    for around in cases {
        assert_eq!(settled(&done, around), None, "{around:?}");
    }
    let mut sleeping = done.clone();
    sleeping.push(e(json!({
        "type": "wake_set", "wake": "w1", "reply": "r1",
        "purpose": { "kind": "sleep" }, "due_ms": 99, "reason": "deploy settles"
    })));
    assert_eq!(settled(&sleeping, Around::default()), None, "its own sleep");
    let job = vec![
        e(link(None)),
        brief(),
        started("r1"),
        e(json!({ "type": "job_started", "reply": "r1", "job": "j1", "name": "research" })),
        finished("r1", "x"),
    ];
    assert_eq!(
        settled(&job, Around::default()),
        None,
        "a background job runs"
    );
    assert_eq!(settled(&[e(link(None))], Around::default()), None, "queued");
}

#[test]
fn a_worker_waiting_on_the_person_reports_once_per_ask() {
    let mut events = vec![e(link(None)), brief(), started("r1")];
    events.push(e(json!({
        "type": "approval_requested", "reply": "r1", "call_id": "c1",
        "name": "shell", "arguments": {}
    })));
    let first = settled(&events, Around::default()).map(|s| (s.state, s.epoch));
    assert_eq!(first, Some((ReportState::NeedsYou, "r1#ask1".to_owned())));
    events.push(e(json!({
        "type": "approval_answered", "reply": "r1", "call_id": "c1", "allowed": true, "always": false
    })));
    events.push(e(json!({
        "type": "approval_requested", "reply": "r1", "call_id": "c2",
        "name": "shell", "arguments": {}
    })));
    let second = settled(&events, Around::default()).map(|s| s.epoch);
    assert_eq!(
        second.as_deref(),
        Some("r1#ask2"),
        "a new ask is a new epoch"
    );
    let below = vec![e(link(None)), brief(), started("r1"), finished("r1", "x")];
    let waiting = Around {
        children_waiting: true,
        ..Around::default()
    };
    assert_eq!(
        settled(&below, waiting).map(|s| s.state),
        Some(ReportState::NeedsYou),
        "its own worker waits on the person"
    );
}

#[test]
fn a_worker_an_old_budget_parked_reports_once_its_wake_is_cancelled_and_failures_say_so() {
    let mut parked = vec![
        e(link(Some(1))),
        brief(),
        started("r1"),
        Event::from_json(
            json!({ "type": "cap_reached", "scope": "budget", "cap_micros": 1, "period_start": 0, "resets_at": 0 }),
        ),
        finished("r1", "Half the sources."),
        e(json!({
            "type": "wake_set", "wake": "w9", "purpose": { "kind": "wait" },
            "condition": { "kind": "budget" }, "reason": "At its budget of $0.000001."
        })),
    ];
    let open = crate::wake::open(&parked);
    assert!(open.iter().all(crate::wake::for_spend) && open.len() == 1);
    assert_eq!(
        settled(&parked, Around::default()),
        None,
        "an open wake holds it"
    );
    parked.push(e(
        json!({ "type": "wake_cancelled", "wake": "w9", "by": "spade" }),
    ));
    let report = settled(&parked, Around::default()).map(|s| s.state);
    assert_eq!(report, Some(ReportState::Finished));
    let old = e(
        json!({ "type": "worker_reported", "worker": "a2", "kind": "bot",
        "name": "Scout", "state": "parked", "epoch": "w9", "summary": "" }),
    );
    assert!(matches!(old, Event::Known(Known::WorkerReported(r)) if r.state == ReportState::Other));

    let failed = vec![
        e(link(None)),
        brief(),
        started("r1"),
        e(json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "key refused" })),
    ];
    let shown = settled(&failed, Around::default()).map(|s| (s.state, s.summary));
    assert_eq!(
        shown,
        Some((
            ReportState::Failed,
            "its reply failed: key refused.".to_owned()
        ))
    );
    let stopped = vec![
        e(link(None)),
        brief(),
        started("r1"),
        e(json!({ "type": "reply_stopped", "reply": "r1", "text": "half" })),
    ];
    let state = settled(&stopped, Around::default()).map(|s| s.state);
    assert_eq!(state, Some(ReportState::Stopped));
    assert!(!ReportState::Stopped.opens_reply());
    assert!(ReportState::Done.opens_reply() && ReportState::NeedsYou.opens_reply());
}

#[test]
fn a_report_is_stored_once_per_worker_epoch_and_state() {
    let report = json!({
        "type": "worker_reported", "worker": "a2", "kind": "bot", "name": "Scout",
        "state": "finished", "epoch": "r1", "summary": "it ended.", "words": "Found <b>it</b>"
    });
    let events = vec![e(report)];
    assert!(reported(&events, "a2", "r1", ReportState::Finished));
    assert!(!reported(&events, "a2", "r2", ReportState::Finished));
    assert!(!reported(&events, "a3", "r1", ReportState::Finished));
    assert!(!reported(&events, "a2", "r1", ReportState::NeedsYou));
    let Event::Known(Known::WorkerReported(stored)) = &events[0] else {
        panic!("a report");
    };
    let text = report_text(stored);
    assert!(text.starts_with("<worker_report worker=\"a2\" kind=\"bot\" state=\"finished\""));
    assert!(text.contains("<worker_words untrusted=\"true\">\n\"Found <b>it</b>\""));
    assert!(crate::wake::untrusted(&Known::WorkerReported(
        stored.clone()
    )));
    assert!(crate::wake::is_note(&Known::WorkerReported(stored.clone())));
}

#[test]
fn a_report_settles_a_wait_for_that_worker_or_any_but_not_another() {
    let wait = |worker: Value| {
        e(json!({
            "type": "wake_set", "wake": "w1", "reply": "r1", "purpose": { "kind": "wait" },
            "condition": { "kind": "worker", "worker": worker }, "reason": ""
        }))
    };
    let report = e(json!({
        "type": "worker_reported", "worker": "a2", "kind": "bot", "name": "Scout",
        "state": "done", "epoch": "r1", "summary": "ok"
    }));
    for (worker, settles) in [
        (json!("a2"), true),
        (json!("Scout"), true),
        (Value::Null, true),
        (json!("a3"), false),
    ] {
        let fired = crate::wake::settled_by(&[wait(worker.clone())], &report);
        assert_eq!(fired.len(), usize::from(settles), "{worker}");
    }
}

#[test]
fn ace_children_follow_delegate_and_wait_results_and_a_stop() {
    let delegate = |job: &str, threads: Value| {
        e(json!({
            "type": "job_finished", "job": job, "name": "delegate",
            "content": json!({ "ok": true, "data": { "threadIds": ["t1", "t2"],
                "wait": { "status": "needs_you", "threads": threads } } }).to_string()
        }))
    };
    let child = |thread: &str| {
        e(json!({
            "type": "worker_started", "worker": thread, "kind": "ace", "name": "Fix", "call": "d1"
        }))
    };
    let mut events = vec![child("t1"), child("t2")];
    let states = |events: &[Event]| -> Vec<(String, AceState)> {
        ace_children(events)
            .into_iter()
            .map(|c| (c.thread, c.state))
            .collect()
    };
    assert_eq!(
        states(&events),
        vec![
            ("t1".to_owned(), AceState::Working),
            ("t2".to_owned(), AceState::Working)
        ]
    );
    events.push(delegate(
        "d1",
        json!([{ "threadId": "t1", "state": "done" }, { "threadId": "t2", "state": "needs_you" }]),
    ));
    assert_eq!(
        states(&events),
        vec![
            ("t1".to_owned(), AceState::Done),
            ("t2".to_owned(), AceState::NeedsYou)
        ]
    );
    assert!(AceState::NeedsYou.waiting());
    // A later wait on t2 makes it working again, then its answer settles it.
    events.push(e(json!({
        "type": "step_finished", "reply": "r2", "text": "",
        "calls": [{ "id": "w1", "name": "wait", "arguments": { "threadIds": ["t2"] } }]
    })));
    events.push(e(
        json!({ "type": "job_started", "reply": "r2", "job": "w1", "name": "wait" }),
    ));
    assert_eq!(states(&events)[1].1, AceState::Working);
    events.push(e(json!({
        "type": "job_finished", "job": "w1", "name": "wait",
        "content": json!({ "ok": true, "data": { "status": "ready",
            "threads": [{ "threadId": "t2", "state": "failed" }] } }).to_string()
    })));
    assert_eq!(states(&events)[1].1, AceState::Failed);
    events.push(e(json!({
        "type": "worker_reported", "worker": "t1", "kind": "ace", "name": "Fix",
        "state": "stopped", "epoch": "stop", "summary": "stopped"
    })));
    assert_eq!(states(&events)[0].1, AceState::Stopped);
    // A job that ended without saying how its children are is not read as still running.
    let unread = vec![
        child("t9"),
        e(
            json!({ "type": "job_finished", "job": "d1", "name": "delegate", "content": "oops", "is_error": true }),
        ),
    ];
    assert_eq!(states(&unread), vec![("t9".to_owned(), AceState::Ended)]);
    // A stop noted before its job's end stays: the stopped job says nothing of its children.
    let stopped = vec![
        child("t9"),
        e(json!({
            "type": "worker_reported", "worker": "t9", "kind": "ace", "name": "Fix",
            "state": "stopped", "epoch": "stop", "summary": "stopped"
        })),
        e(
            json!({ "type": "job_finished", "job": "d1", "name": "delegate", "content": "Stopped by the person.", "is_error": true }),
        ),
    ];
    assert_eq!(states(&stopped), vec![("t9".to_owned(), AceState::Stopped)]);
    assert_eq!(
        delegated_threads(&json!({ "ok": true, "data": { "threadIds": ["t1"] } }).to_string()),
        vec!["t1".to_owned()]
    );
}

#[test]
fn an_ace_child_being_stopped_counts_as_running_until_ace_confirms() {
    let child = e(json!({
        "type": "worker_started", "worker": "t1", "kind": "ace", "name": "Fix", "call": "d1"
    }));
    let report = |state: &str| {
        e(json!({
            "type": "worker_reported", "worker": "t1", "kind": "ace", "name": "Fix",
            "state": state, "epoch": state, "summary": ""
        }))
    };
    let result = |job: &str, name: &str, state: &str| {
        e(json!({
            "type": "job_finished", "job": job, "name": name,
            "content": json!({ "ok": true, "data": { "threadIds": ["t1"],
                "threads": [{ "threadId": "t1", "state": state }] } }).to_string()
        }))
    };
    let state = |events: &[Event]| ace_children(events).first().map(|c| c.state);
    let stopping = vec![child.clone(), report("stopping")];
    assert_eq!(state(&stopping), Some(AceState::Stopping));
    assert!(AceState::Stopping.working() && AceState::Stopping.unsettled());
    assert_eq!(ace_stopping(&stopping).len(), 1, "its cancel is owed");
    let cases = [
        // ace still says it works: it stays stopping.
        (
            result("d1", "delegate", "working"),
            Some(AceState::Stopping),
        ),
        // Its job was cut off by the stop and said nothing of it.
        (
            e(
                json!({ "type": "job_finished", "job": "d1", "name": "delegate",
                       "content": "Stopped by the person.", "is_error": true }),
            ),
            Some(AceState::Stopping),
        ),
        // ace confirmed, or it settled meanwhile.
        (report("stopped"), Some(AceState::Stopped)),
        (
            result("d1", "delegate", "cancelled"),
            Some(AceState::Stopped),
        ),
        (result("d1", "delegate", "done"), Some(AceState::Done)),
    ];
    for (then, expected) in cases {
        let mut events = stopping.clone();
        events.push(then.clone());
        assert_eq!(state(&events), expected, "{then:?}");
    }
    // A child that had settled is not made running by a late stop.
    let done = vec![child, result("d1", "delegate", "done"), report("stopping")];
    assert_eq!(state(&done), Some(AceState::Done));
    // Being stopped is not a report that settles a wait for that worker.
    let wait = e(json!({
        "type": "wake_set", "wake": "w1", "reply": "r1", "purpose": { "kind": "wait" },
        "condition": { "kind": "worker", "worker": "t1" }, "reason": ""
    }));
    assert!(crate::wake::settled_by(std::slice::from_ref(&wait), &report("stopping")).is_empty());
    assert_eq!(
        crate::wake::settled_by(&[wait], &report("stopped")).len(),
        1
    );
}

#[test]
fn a_worker_never_gets_more_tools_than_its_parent() {
    let granted = vec!["web_search".to_owned()];
    assert!(allows(Some(&granted), "web_search"));
    assert!(!allows(Some(&granted), "shell"));
    assert!(
        allows(Some(&granted), crate::tools::TOOL_SEARCH),
        "finding tools"
    );
    assert!(allows(None, "shell"), "unset grants all of the parent's");
    let asked = vec!["web_search".to_owned(), "send_email".to_owned()];
    assert_eq!(
        ungrantable(&asked, |name| name == "web_search"),
        vec!["send_email"]
    );
}
