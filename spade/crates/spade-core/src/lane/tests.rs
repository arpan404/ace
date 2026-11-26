use serde_json::{Value, json};

use super::*;
use crate::tree::{Kind, Report, ReportState};

/// An event from its stored JSON, failing the test when Spade would not read it as known.
fn e(value: Value) -> Event {
    match Event::from_json(value.clone()) {
        Event::Known(known) => Event::Known(known),
        Event::Unknown(_) => panic!("not a known event: {value}"),
    }
}

fn person(text: &str) -> Event {
    Event::user_message(text)
}

fn started(reply: &str) -> Event {
    Event::reply_started(reply, "e/m")
}

fn started_by(reply: &str, lane: &str) -> Event {
    e(json!({ "type": "reply_started", "reply": reply, "model": "e/m", "lane": lane }))
}

fn finished(reply: &str, text: &str) -> Event {
    e(json!({ "type": "reply_finished", "reply": reply, "text": text, "cost_micros": 0 }))
}

fn step(reply: &str, text: &str) -> Event {
    e(json!({ "type": "step_finished", "reply": reply, "text": text }))
}

fn lane_of(title: &str) -> Event {
    e(json!({ "type": "lane_of", "parent_conversation": "c1", "call": "c1.t1", "title": title }))
}

fn lane_started(lane: &str, asks: &[&str]) -> Event {
    e(
        json!({ "type": "lane_started", "lane": lane, "conversation": lane, "title": "Fix the \
              March invoice", "call": "c1.t1", "asks": asks }),
    )
}

fn report(lane: &str, state: ReportState) -> Event {
    Event::Known(Known::WorkerReported(Report {
        worker: lane.to_owned(),
        kind: Kind::Lane,
        name: "Fix the March invoice".to_owned(),
        state,
        epoch: "r9".to_owned(),
        summary: "it ended its turn with no goal checked.".to_owned(),
        words: None,
        error: None,
        untrusted: false,
    }))
}

fn quiet() -> crate::tree::Around {
    crate::tree::Around::default()
}

fn carries_on() -> crate::tree::Around {
    crate::tree::Around {
        carries_on: true,
        ..quiet()
    }
}

fn approval(reply: &str, call: &str) -> Event {
    e(
        json!({ "type": "approval_requested", "reply": reply, "call_id": call,
              "name": "send_email", "arguments": {}, "reviewer_reason": null }),
    )
}

#[test]
fn a_lane_reads_queued_working_needs_you_and_how_it_ended() {
    let mut events = vec![lane_of("Fix the March invoice"), person("Fix it.")];
    assert_eq!(state(&events, quiet()), State::Queued);
    events.push(started("r1"));
    assert_eq!(state(&events, quiet()), State::Working);
    events.push(approval("r1", "k1"));
    assert_eq!(state(&events, quiet()), State::NeedsYou);
    events.push(e(
        json!({ "type": "approval_answered", "reply": "r1", "call_id": "k1",
                          "allowed": true, "always": false }),
    ));
    assert_eq!(state(&events, quiet()), State::Working);
    let mut done = events.clone();
    done.push(finished("r1", "Sent."));
    assert_eq!(state(&done, quiet()), State::Finished);
    assert_eq!(
        state(&done, carries_on()),
        State::Working,
        "a task that carries on by itself has not ended"
    );
    let mut failed = events.clone();
    failed.push(e(
        json!({ "type": "reply_failed", "reply": "r1", "text": "",
                          "error": "the endpoint refused" }),
    ));
    assert_eq!(state(&failed, quiet()), State::Failed);
    let mut stopped = events;
    stopped.push(Event::reply_ended(
        crate::event::ReplyEnd::Stopped,
        "r1",
        "",
    ));
    assert_eq!(state(&stopped, quiet()), State::Stopped);
    // The person writes in an ended lane: it works again.
    done.push(person("Also cc Sam."));
    done.push(started("r2"));
    assert_eq!(state(&done, quiet()), State::Working);
}

#[test]
fn the_task_list_reads_needs_you_then_running_then_ended_then_queued_oldest_first() {
    let mut rows = vec![
        ("queued", State::Queued, 1),
        ("done", State::Done, 2),
        ("working-late", State::Working, 9),
        ("needs", State::NeedsYou, 5),
        ("working-early", State::Working, 3),
        ("failed", State::Failed, 4),
    ];
    order(&mut rows, |(_, state, at)| (*state, *at));
    let names: Vec<&str> = rows.iter().map(|(name, _, _)| *name).collect();
    assert_eq!(
        names,
        [
            "needs",
            "working-early",
            "working-late",
            "failed",
            "done",
            "queued"
        ]
    );
}

#[test]
fn a_reply_to_a_lanes_line_or_to_the_words_its_report_opened_goes_to_that_lane() {
    let events = vec![
        person("Fix the March invoice."),                 // m1
        started("r1"),                                    // m2
        lane_started("l1", &["m1"]),                      // m3
        finished("r1", "Started a task for it."),         // m4
        report("l1", ReportState::Done),                  // m5
        started_by("r2", "l1"),                           // m6
        finished("r2", "The invoice is fixed and sent."), // m7
        person("What time is it in Lisbon?"),             // m8
        started("r3"),                                    // m9
        finished("r3", "It's 14:05."),                    // m10
        person("And the PDF too"),                        // m11
        e(
            json!({ "type": "ask_routed", "lane": "l1", "title": "Fix the March invoice",
                  "message": "m11" }),
        ), // m12
    ];
    assert_eq!(
        replied_to(&events, "m3").as_deref(),
        Some("l1"),
        "the started line"
    );
    assert_eq!(
        replied_to(&events, "m5").as_deref(),
        Some("l1"),
        "the report"
    );
    assert_eq!(
        replied_to(&events, "m7").as_deref(),
        Some("l1"),
        "the bot's words the report opened"
    );
    assert_eq!(
        replied_to(&events, "m11").as_deref(),
        Some("l1"),
        "the person's own routed message"
    );
    assert_eq!(replied_to(&events, "m10"), None, "an answer of main's own");
    assert_eq!(
        replied_to(&events, "m4"),
        None,
        "main's words before the report"
    );
    assert_eq!(
        replied_to(&events, "m1"),
        None,
        "the person's own unrouted message"
    );
    assert_eq!(replied_to(&events, "m99"), None);
    assert_eq!(replied_to(&events, "nonsense"), None);
}

fn messaged(lane: &str, asks: &[&str]) -> Event {
    e(json!({ "type": "lane_messaged", "lane": lane, "title": "T", "asks": asks }))
}

fn routed(lane: &str, message: &str) -> Event {
    e(json!({ "type": "ask_routed", "lane": lane, "title": "T", "message": message }))
}

#[test]
fn only_the_persons_own_reply_routed_to_a_task_authorizes_stopping_it() {
    let events = vec![
        person("Fix the March invoice."), // m1
        started("r1"),
        lane_started("l1", &["m1"]), // m3
        finished("r1", "Started."),
        person("Stop the invoice."), // m5: typed in main, not routed
        started("r2"),
        messaged("l1", &["m5"]), // m7: main forwarded it
        finished("r2", "Forwarded."),
        person("Stop, please."), // m9: the person's reply to the task
        routed("l1", "m9"),      // m10
        report("l1", ReportState::Finished),
    ];
    assert_eq!(
        stop_allowed(&events, "l1", "m9"),
        Ok(()),
        "a report since doesn't make it stale"
    );
    assert!(
        stop_allowed(&events, "l1", "m5").is_err(),
        "main's forwarding never authorizes"
    );
    assert!(
        stop_allowed(&events, "l2", "m9").is_err(),
        "routed to another task"
    );
    assert!(stop_allowed(&events, "l1", "m1").is_err());
    assert!(stop_allowed(&events, "l1", "").is_err());
    // A newer reply the person routed to the task makes the older one stale.
    let mut newer = events.clone();
    newer.push(person("Actually, keep going.")); // m12
    newer.push(routed("l1", "m12"));
    assert!(stop_allowed(&newer, "l1", "m9").is_err());
    // A routed message from another bot is never the person's.
    let mut other = events;
    other.push(e(json!({ "type": "user_message", "text": "stop it",
                         "from_agent": { "id": "a9", "name": "Other", "depth": 1 } }))); // m12
    other.push(routed("l1", "m12"));
    assert!(stop_allowed(&other, "l1", "m12").is_err());
}

#[test]
fn a_reply_records_the_lane_whose_report_alone_opened_it() {
    let base = vec![person("Hi"), started("r0"), finished("r0", "Hello")];
    let mut opened = base.clone();
    opened.push(report("l1", ReportState::Done));
    assert_eq!(opener(&opened).as_deref(), Some("l1"));
    let mut with_message = opened.clone();
    with_message.push(person("And the PDF?"));
    assert_eq!(
        opener(&with_message),
        None,
        "a person's message is nobody's lane"
    );
    let mut two = opened.clone();
    two.push(report("l2", ReportState::Done));
    assert_eq!(opener(&two), None, "two lanes' reports");
    let mut quiet = base.clone();
    quiet.push(report("l1", ReportState::Stopped));
    assert_eq!(opener(&quiet), None, "a stop opens nothing");
    // A report stored while turns couldn't start, then a reply started separately with no lane
    // recorded: its words belong to no lane, whatever sits next to it.
    let mut resumed = opened.clone();
    resumed.push(started("r1"));
    resumed.push(finished("r1", "Done: the invoice.")); // m6
    assert_eq!(replied_to(&resumed, "m6"), None);
}

fn long_reply(steps: usize) -> Vec<Event> {
    let mut events = vec![person("Draft the quarterly note."), started("r1")];
    for n in 0..steps {
        events.push(step("r1", &format!("step {n}")));
    }
    events
}

#[test]
fn a_deferred_question_keeps_one_owner_until_it_is_resolved() {
    let mut events = long_reply(9);
    events.push(e(json!({
        "type": "question_asked", "reply": "r1", "call_id": "q1", "question": "Which build?"
    })));
    events.push(e(
        json!({"type": "question_deferred", "call_id": "q1", "by_bot": true}),
    ));
    assert!(!move_due(&events, "r1", MOVE_AFTER_MS));
    events.push(e(
        json!({"type": "question_answered", "call_id": "q1", "answers": ["Release"], "late": true}),
    ));
    assert!(move_due(&events, "r1", MOVE_AFTER_MS));
}

#[test]
fn mains_reply_moves_after_eight_steps_or_two_minutes_at_a_quiet_boundary() {
    assert!(!move_due(&long_reply(7), "r1", 0));
    assert!(move_due(&long_reply(8), "r1", 0));
    assert!(move_due(&long_reply(1), "r1", MOVE_AFTER_MS));
    assert!(
        !move_due(&long_reply(0), "r1", MOVE_AFTER_MS),
        "no step taken yet"
    );
    let mut waiting = long_reply(9);
    waiting.push(approval("r1", "k1"));
    assert!(!move_due(&waiting, "r1", 0), "waits on the person first");
    let mut answered = waiting.clone();
    answered.push(e(
        json!({ "type": "approval_answered", "reply": "r1", "call_id": "k1",
                            "allowed": true, "always": false }),
    ));
    assert!(move_due(&answered, "r1", 0), "moves once answered");
    let mut lane = vec![lane_of("A task")];
    lane.extend(long_reply(12));
    assert!(
        !move_due(&lane, "r1", MOVE_AFTER_MS),
        "a lane's work never moves"
    );
}

#[test]
fn a_moved_lane_starts_from_the_persons_words_the_recent_chat_and_the_reply_so_far() {
    let mut events = vec![
        person("Hi"),
        started("r0"),
        finished("r0", "Hello!"),
        person("Draft the quarterly note."), // m4
        started("r1"),
        step("r1", "Reading Q3.xlsx"),
    ];
    events.push(person("Use March, not February.")); // a steer while it ran
    events.push(step("r1", "Using March"));
    let Some((lane, asks)) = moved(&events, "r1") else {
        panic!("the reply is there");
    };
    assert_eq!(asks, ["m4"]);
    let Event::Known(Known::UserMessage { text, context, .. }) = &lane[0] else {
        panic!("the person's message comes first");
    };
    assert_eq!(text, "Draft the quarterly note.");
    let context = context.as_deref().unwrap_or_default();
    assert!(context.contains("person: Hi") && context.contains("you: Hello!"));
    assert!(
        !context.contains("quarterly"),
        "the ask itself is the message"
    );
    assert_eq!(&lane[1..], &events[4..], "the reply's events, as stored");
    assert!(moved(&events, "r9").is_none());
}

#[test]
fn asks_a_lane_took_leave_mains_ledger_and_its_stop_check() {
    let events = vec![
        person("Fix the March invoice."),
        person("What time is it in Lisbon?"),
        started("r1"),
        lane_started("l1", &["m1"]),
    ];
    let ledger = crate::asks::Ledger::of(&events);
    let open: Vec<&str> = ledger.open_asks().map(|a| a.id.as_str()).collect();
    assert_eq!(open, ["m2"], "the invoice is the lane's now");
    let mut routed = events.clone();
    routed.push(person("And the PDF too"));
    routed.push(e(
        json!({ "type": "ask_routed", "lane": "l1", "title": "Fix the March invoice",
                          "message": "m5" }),
    ));
    let ledger = crate::asks::Ledger::of(&routed);
    assert!(
        ledger.ask("m5").is_none(),
        "a routed message is the lane's ask"
    );
}

#[test]
fn mains_tasks_block_lists_only_lanes_that_havent_ended() {
    let lane = |id: &str| Started {
        lane: id.to_owned(),
        conversation: id.to_owned(),
        title: format!("Task <{id}>"),
        call: "c1.t".to_owned(),
        asks: vec!["m1".to_owned()],
        moved_from: None,
        queued: false,
    };
    assert_eq!(block(&[(lane("l1"), State::Done)]), None);
    let text = block(&[
        (lane("l1"), State::Working),
        (lane("l2"), State::Done),
        (lane("l3"), State::Queued),
    ])
    .unwrap_or_default();
    assert!(text.contains("- l1 (working): Task l1, owns m1"));
    assert!(text.contains("- l3 (queued)"));
    assert!(!text.contains("l2"));
}

#[test]
fn a_lanes_approval_keeps_main_waiting_until_answered_or_the_lane_moves_on() {
    let asked = e(
        json!({ "type": "approval_requested", "reply": "r1", "call_id": "l1.k1",
                          "name": "send_email", "arguments": {}, "reviewer_reason": null,
                          "lane": { "task": "l1", "conversation": "l1", "call_id": "k1",
                                    "title": "Fix the March invoice" } }),
    );
    let mut events = vec![
        person("Fix it"),
        started("r1"),
        finished("r1", "On it."),
        asked,
    ];
    assert!(Transcript::fold(&events).waiting_on_you());
    assert!(
        Transcript::fold(&events).open_reply().is_none(),
        "main's own reply never waits on it"
    );
    events.push(report("l1", ReportState::Stopped));
    assert!(
        !Transcript::fold(&events).waiting_on_you(),
        "a stopped lane asks nothing more"
    );
}

#[test]
fn a_title_is_the_first_line_of_the_persons_words_cut() {
    assert_eq!(
        title_of("\n  Fix the March invoice\nthen send it"),
        "Fix the March invoice"
    );
    assert_eq!(title_of(""), "A task");
    assert_eq!(title_of(&"x".repeat(200)).chars().count(), TITLE_CHARS);
}

#[test]
fn lane_events_round_trip_through_json() {
    for raw in [
        json!({ "type": "lane_of", "parent_conversation": "c1", "call": "c1.t1",
                "title": "T", "asks": ["m1"], "untrusted": true, "moved_from": "r1" }),
        json!({ "type": "lane_of", "parent_conversation": "c1", "call": "c1.t1",
                "title": "T", "copied_events": 2, "person_source": { "id": "m1", "text": "Hi" } }),
        json!({ "type": "lane_started", "lane": "l1", "conversation": "l1", "title": "T",
                "call": "c1.t1", "asks": ["m1"], "queued": true }),
        json!({ "type": "reply_moved", "reply": "r1", "lane": "l1", "title": "T",
                "asks": ["m1"] }),
        json!({ "type": "ask_routed", "lane": "l1", "title": "T", "message": "m4" }),
    ] {
        let event = e(raw.clone());
        assert_eq!(event.to_json(), raw);
    }
}

#[test]
fn a_task_main_moved_to_a_lane_is_never_carried_on_in_main() {
    let status = e(json!({ "type": "step_finished", "reply": "r1", "text": "",
                           "calls": [{ "id": "k1", "name": "task_status",
                                       "arguments": { "status": "working" } }] }));
    let mut events = vec![person("Draft the note."), started("r1"), status.clone()];
    assert!(!task_moved(&events));
    events.push(e(
        json!({ "type": "reply_moved", "reply": "r1", "lane": "l1", "title": "T" }),
    ));
    events.push(finished("r1", ""));
    assert!(task_moved(&events));
    // Main sets a task of its own later: that one is main's.
    events.extend([person("Now tidy my notes."), started("r2"), status]);
    assert!(!task_moved(&events));
}

#[test]
fn a_lane_that_writes_a_file_another_working_lane_wrote_is_told_once() {
    let wrote = |path: &str, ok: bool| {
        vec![
            e(json!({ "type": "step_finished", "reply": "r1", "text": "",
                      "calls": [{ "id": "w1", "name": "workspace_write",
                                  "arguments": { "path": path, "content": "x" } }] })),
            e(
                json!({ "type": "tool_finished", "reply": "r1", "call_id": "w1",
                      "name": "workspace_write", "content": "ok", "is_error": !ok }),
            ),
        ]
    };
    let mine = written(&wrote("./crm.md", true));
    assert_eq!(mine.iter().collect::<Vec<_>>(), ["crm.md"]);
    assert!(
        written(&wrote("crm.md", false)).is_empty(),
        "a failed write wrote nothing"
    );
    let others = vec![
        (
            "l1".to_owned(),
            "Compare the quotes".to_owned(),
            written(&wrote("crm.md", true)),
        ),
        (
            "l3".to_owned(),
            "Other".to_owned(),
            written(&wrote("notes.md", true)),
        ),
    ];
    let found = overlaps(("l2", "Summarise the quotes", &mine), &others, &[]);
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].path.as_str(), found[0].other.as_str()),
        ("crm.md", "l1")
    );
    let noted = vec![Event::Known(Known::LanesOverlapped(found[0].clone()))];
    assert!(
        overlaps(("l2", "Summarise the quotes", &mine), &others, &noted).is_empty(),
        "noted once"
    );
}

#[test]
fn a_moved_replys_jobs_move_except_those_main_tracks_and_its_wakes_go_with_it() {
    let mut events = vec![person("Draft the note."), started("r1")];
    for (job, name) in [("j1", "fetch_report"), ("j2", "delegate"), ("j3", "helper")] {
        events.push(e(
            json!({ "type": "job_started", "reply": "r1", "job": job, "name": name }),
        ));
    }
    events.push(e(
        json!({ "type": "job_finished", "job": "j3", "name": "helper",
                          "content": "done", "is_error": false }),
    ));
    events.push(e(json!({ "type": "wake_set", "wake": "w1", "reply": "r1",
                          "purpose": { "kind": "sleep" }, "due_ms": 5, "reason": "later" })));
    events.push(e(json!({ "type": "wake_set", "wake": "w2", "reply": "r0",
                          "purpose": { "kind": "sleep" }, "due_ms": 5, "reason": "older" })));
    let (moved, kept, wakes) = work_of(&events, "r1", |name| name == "delegate");
    assert_eq!(moved, ["j1"], "an ended job is nobody's");
    assert_eq!(kept, ["j2"]);
    assert_eq!(wakes, ["w1"], "only the moved reply's own wakes");
    // Main no longer holds the moved job open.
    events.push(e(
        json!({ "type": "reply_moved", "reply": "r1", "lane": "l1", "title": "T",
                          "jobs": ["j1"], "kept_jobs": ["j2"], "wakes": ["w1"] }),
    ));
    assert_eq!(Transcript::fold(&events).jobs, ["j2"]);
}

#[test]
fn a_lane_whose_reply_closed_reads_working_while_its_job_or_a_worker_under_it_runs() {
    let mut events = vec![
        lane_of("Fetch the report"),
        person("Fetch it."),
        started("r1"),
        e(json!({ "type": "job_started", "reply": "r1", "job": "j1", "name": "fetch" })),
        finished("r1", "Waiting for the report."),
    ];
    assert_eq!(
        state(&events, quiet()),
        State::Working,
        "its job still runs"
    );
    events.push(e(
        json!({ "type": "job_finished", "job": "j1", "name": "fetch",
                          "content": "done", "is_error": false }),
    ));
    assert_eq!(state(&events, quiet()), State::Finished);
    let under = |working, waiting| crate::tree::Around {
        children_working: working,
        children_waiting: waiting,
        ..quiet()
    };
    assert_eq!(
        state(&events, under(true, false)),
        State::Working,
        "a worker under it runs"
    );
    assert_eq!(state(&events, under(false, true)), State::NeedsYou);
}

#[test]
fn a_quiet_stopped_report_is_never_taken_for_the_one_that_opened_a_reply() {
    let events = vec![
        person("Book flights."), // m1
        started("r1"),
        lane_started("l1", &["m1"]),
        finished("r1", "Started."),
        report("l1", ReportState::Stopped), // m5
        person("What now?"),                // m6
        started("r2"),
        finished("r2", "Nothing runs."), // m8
    ];
    assert_eq!(replied_to(&events, "m8"), None);
    let mut opened = events.clone();
    opened.push(report("l2", ReportState::Done)); // m9
    opened.push(started_by("r3", "l2"));
    opened.push(finished("r3", "The other task is done.")); // m11
    assert_eq!(replied_to(&opened, "m11").as_deref(), Some("l2"));
}

#[test]
fn a_lane_started_with_untrusted_content_in_main_is_untrusted_in_view() {
    let link = |untrusted: bool| {
        e(
            json!({ "type": "lane_of", "parent_conversation": "c1", "call": "c1.t1",
                  "title": "T", "untrusted": untrusted }),
        )
    };
    let registry = crate::tools::Registry::default();
    let tainted = vec![link(true), person("Do it."), started("r1")];
    assert_eq!(
        crate::context::untrusted_in_view(&tainted, &registry).len(),
        1
    );
    assert!(
        crate::context::untrusted_in_view(&[link(false), person("Do it.")], &registry).is_empty()
    );
    // Main's words to a lane never pass for the person's: no ask, and tainted when marked.
    let steered = vec![
        link(false),
        person("Do it."),
        e(json!({ "type": "lane_message", "text": "Use March.", "untrusted": true })),
    ];
    assert_eq!(crate::asks::Ledger::of(&steered).open_asks().count(), 1);
    assert_eq!(
        crate::context::untrusted_in_view(&steered, &registry).len(),
        1
    );
}

#[test]
fn a_lanes_end_closes_mains_copies_nothing_can_answer_and_its_later_cards_only_on_stop() {
    let ask = |call: &str, lane: &str| {
        e(
            json!({ "type": "question_asked", "reply": "r1", "call_id": call, "question": "?",
                  "lane": { "task": lane, "conversation": lane, "call_id": "q", "title": "T" } }),
        )
    };
    let events = vec![
        ask("l1.q1", "l1"),
        ask("l1.q2", "l1"),
        e(json!({ "type": "question_deferred", "call_id": "l1.q2" })),
        ask("l2.q1", "l2"),
        e(
            json!({ "type": "approval_requested", "reply": "r1", "call_id": "l1.k1",
                  "name": "send", "arguments": {}, "reviewer_reason": null,
                  "lane": { "task": "l1", "conversation": "l1", "call_id": "k1", "title": "T" } }),
        ),
    ];
    let finished = requests_closing(&events, "l1", None, ReportState::Finished);
    assert_eq!(
        finished,
        ["l1.q1", "l1.k1"],
        "a card left for later stays answerable"
    );
    let stopped = requests_closing(&events, "l1", None, ReportState::Stopped);
    assert_eq!(stopped, ["l1.q1", "l1.q2", "l1.k1"]);
    let mut closed = events.clone();
    closed.push(e(json!({ "type": "lane_requests_closed", "lane": "l1",
                          "calls": ["l1.q1", "l1.q2", "l1.k1"] })));
    assert!(requests_closing(&closed, "l1", None, ReportState::Stopped).is_empty());
    assert!(
        !Transcript::fold(&closed)
            .helper_awaiting
            .iter()
            .any(|(c, _)| c == "l1.k1")
    );
    assert_eq!(
        requests_closing(&closed, "l2", None, ReportState::Stopped),
        ["l2.q1"],
        "only its own"
    );
}

#[test]
fn a_runs_end_closes_only_that_runs_copies_and_a_stale_end_does_not_stand() {
    let ask = |call: &str, run: &str| {
        e(
            json!({ "type": "question_asked", "reply": "r1", "call_id": call, "question": "?",
                  "lane": { "task": "l1", "conversation": "l1", "call_id": "q1", "title": "T",
                            "epoch": run } }),
        )
    };
    // The same call id in the lane's second run is a new copy in main.
    assert_ne!(copy_id("l1", "lr1", "q1"), copy_id("l1", "lr2", "q1"));
    let events = vec![ask("l1.lr1.q1", "lr1"), ask("l1.lr2.q1", "lr2")];
    assert_eq!(
        requests_closing(&events, "l1", Some("lr1"), ReportState::Finished),
        ["l1.lr1.q1"]
    );
    // A lane's end stands only while its latest run is the one that ended and nothing reopened it.
    let mut lane = vec![
        lane_of("T"),
        person("Do it."),
        started("lr1"),
        finished("lr1", "ok"),
    ];
    assert!(ended_run_current(&lane, "lr1"));
    lane.push(person("Once more."));
    lane.push(started("lr2"));
    assert!(!ended_run_current(&lane, "lr1"), "reopened since");
    assert!(!ended_run_current(&lane, "lr2"), "still running");
    assert!(ended_run_current(
        &[lane_of("T"), person("Do it.")],
        "queued"
    ));
}

#[test]
fn moving_main_does_not_republish_cards_owned_by_another_conversation()
-> Result<(), Box<dyn std::error::Error>> {
    let mut events = long_reply(9);
    let other = json!({"task":"other","conversation":"other","call_id":"k1","title":"Other task"});
    events.push(e(json!({
        "type":"approval_requested", "reply":"r1", "call_id":"other.k1",
        "name":"publish", "arguments":{}, "lane":other
    })));
    events.push(e(json!({
        "type":"question_asked", "reply":"r1", "call_id":"other.q1",
        "question":"Which version?", "lane":other
    })));
    let (lane, _) = moved(&events, "r1").ok_or("open reply did not move")?;
    assert!(Transcript::fold(&lane).helper_awaiting.is_empty());
    assert!(
        !lane
            .iter()
            .any(|event| matches!(event, Event::Known(Known::QuestionAsked { .. })))
    );
    assert!(!Transcript::fold(&events).helper_awaiting.is_empty());
    Ok(())
}
