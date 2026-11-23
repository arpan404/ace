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
    }))
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
    assert_eq!(state(&events, false), State::Queued);
    events.push(started("r1"));
    assert_eq!(state(&events, false), State::Working);
    events.push(approval("r1", "k1"));
    assert_eq!(state(&events, false), State::NeedsYou);
    events.push(e(
        json!({ "type": "approval_answered", "reply": "r1", "call_id": "k1",
                          "allowed": true, "always": false }),
    ));
    assert_eq!(state(&events, false), State::Working);
    let mut done = events.clone();
    done.push(finished("r1", "Sent."));
    assert_eq!(state(&done, false), State::Finished);
    assert_eq!(
        state(&done, true),
        State::Working,
        "a task that carries on by itself has not ended"
    );
    let mut failed = events.clone();
    failed.push(e(
        json!({ "type": "reply_failed", "reply": "r1", "text": "",
                          "error": "the endpoint refused" }),
    ));
    assert_eq!(state(&failed, false), State::Failed);
    let mut stopped = events;
    stopped.push(Event::reply_ended(
        crate::event::ReplyEnd::Stopped,
        "r1",
        "",
    ));
    assert_eq!(state(&stopped, false), State::Stopped);
    // The person writes in an ended lane: it works again.
    done.push(person("Also cc Sam."));
    done.push(started("r2"));
    assert_eq!(state(&done, false), State::Working);
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
        started("r2"),                                    // m6
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

#[test]
fn task_stop_needs_a_message_the_person_wrote_naming_it() {
    let events = vec![
        person("Never mind the invoice."),
        started("r1"),
        finished("r1", "Stopping it."),
        e(json!({ "type": "user_message", "text": "stop it",
                  "from_agent": { "id": "a9", "name": "Other", "depth": 1 } })),
    ];
    assert_eq!(stop_allowed(&events, "m1"), Ok(()));
    assert!(stop_allowed(&events, "m3").is_err(), "the bot's own words");
    assert!(
        stop_allowed(&events, "m4").is_err(),
        "another bot's message"
    );
    assert!(stop_allowed(&events, "").is_err(), "no because at all");
    assert!(stop_allowed(&events, "m40").is_err());
}

fn long_reply(steps: usize) -> Vec<Event> {
    let mut events = vec![person("Draft the quarterly note."), started("r1")];
    for n in 0..steps {
        events.push(step("r1", &format!("step {n}")));
    }
    events
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
