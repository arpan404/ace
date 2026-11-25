// SPDX-License-Identifier: Apache-2.0
//! Discovery's behaviour (`session-discovery.ts`, `session-state.ts`): the
//! recovery timers, the revision fence, the output-recovery cycle and the
//! queue refresh.

use ace_json::Value;
use ace_supervisor::peer::Direction;

use super::*;
use crate::session::frames::{Effect, FrameDir};

fn session() -> Session {
    let mut session = Session::new(crate::session::state::SessionConfig {
        scope: "scope-1".to_owned(),
        started: 0.0,
        cwd: "/repo".to_owned(),
        bearer: None,
        redact: Box::new(|line: &str| line.to_owned()),
        foreign: Box::new(|_| false),
    });
    session.attached("root-1", false, false);
    session
}

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("fixture parses")
}

fn note(effect: &Effect) -> Option<Value> {
    let Effect::Frame { dir, text, .. } = effect else {
        return None;
    };
    (*dir == FrameDir::Note).then(|| ace_json::parse(text).expect("a note parses"))
}

fn call_of(effect: &Effect) -> Option<u64> {
    match effect {
        Effect::Request { call, .. } => Some(*call),
        _ => None,
    }
}

fn method_of(effect: &Effect) -> Option<&str> {
    match effect {
        Effect::Request { method, .. } => Some(method),
        _ => None,
    }
}

fn thread_read(id: &str, status: &str, turns: &str) -> Value {
    json(&format!(
        "{{\"thread\":{{\"id\":\"{id}\",\"status\":{{\"type\":\"{status}\"}},\"turns\":[{turns}]}}}}"
    ))
}

fn ready(turns: &str) -> super::HistoryReady {
    super::HistoryReady {
        turns: if turns.is_empty() {
            Vec::new()
        } else {
            vec![json(turns)]
        },
        omitted: Vec::new(),
        notes: Vec::new(),
    }
}

#[test]
fn a_snapshot_is_uncertain_only_while_a_completion_it_missed_stays_unexplained() {
    let started = Revision {
        read: 1,
        current: 1,
    };
    assert!(!recovery_uncertain(
        &json(
            "{\"status\":{\"type\":\"active\"},\"turns\":[{\"id\":\"t1\",\"status\":\"inProgress\"}]}"
        ),
        started,
        &ReadObservation::default(),
    ));
    let observed = ReadObservation {
        started: Some("t2".to_owned()),
        completed: RecentSet::new(),
    };
    let stale = Revision {
        read: 1,
        current: 2,
    };
    // A newer turn started: the status cannot be the read's.
    assert!(!recovery_uncertain(
        &json(
            "{\"status\":{\"type\":\"active\"},\"turns\":[{\"id\":\"t1\",\"status\":\"inProgress\"}]}"
        ),
        stale,
        &observed,
    ));
    // A completion seen live explains the active status.
    let mut completed = ReadObservation::default();
    completed.completed.add("t1".to_owned());
    assert!(!recovery_uncertain(
        &json(
            "{\"status\":{\"type\":\"active\"},\"turns\":[{\"id\":\"t1\",\"status\":\"inProgress\"}]}"
        ),
        stale,
        &completed,
    ));
    // An active status with no running turn and no completion is unexplained.
    assert!(recovery_uncertain(
        &json("{\"status\":{\"type\":\"active\"},\"turns\":[]}"),
        stale,
        &ReadObservation::default(),
    ));
    // And a running turn the read never saw complete is unexplained.
    assert!(recovery_uncertain(
        &json(
            "{\"status\":{\"type\":\"active\"},\"turns\":[{\"id\":\"t1\",\"status\":\"inProgress\"}]}"
        ),
        stale,
        &ReadObservation::default(),
    ));
}

#[test]
fn a_recovery_timer_reads_the_thread_and_its_current_snapshot_settles_it() {
    let mut session = session();
    // A frame for a thread nobody knows arms its recovery.
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"child-1\",\"turn\":{\"id\":\"t1\"}}}"),
        None,
        0.0,
    );
    assert!(effects.contains(&Effect::ArmTimer {
        key: "child-1".to_owned(),
        ms: 2_000.0
    }));
    assert!(session.timers.contains_key("child-1"));
    let effects = session.timer("child-1", 2_000.0);
    assert_eq!(method_of(&effects[0]), Some("thread/read"));
    assert!(!session.timers.contains_key("child-1"));
    // A read of a thread with no owned ancestor drops without a discovery note.
    let call = call_of(&effects[0]).expect("the read's call");
    let effects = session.settled(call, Ok(&thread_read("child-1", "idle", "")));
    assert!(effects.is_empty());
    assert!(!session.recovered.contains("child-1"));
}

#[test]
fn a_read_of_the_root_records_its_snapshot_and_clears_its_uncertainty() {
    let mut session = session();
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"root-1\",\"turn\":{\"id\":\"t1\"}}}"),
        None,
        0.0,
    );
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, Effect::Frame { .. }))
    );
    let effects = session.read_root("root-1");
    let call = call_of(&effects[0]).expect("the snapshot call");
    let effects = session.settled(
        call,
        Ok(&thread_read(
            "root-1",
            "idle",
            "{\"id\":\"t1\",\"status\":\"completed\"}",
        )),
    );
    assert_eq!(effects.len(), 1);
    assert_eq!(method_of(&effects[0]), None);
    assert!(matches!(effects[0], Effect::ReadHistory { .. }));
    let history = match &effects[0] {
        Effect::ReadHistory { call, .. } => *call,
        _ => 0,
    };
    let effects = session.history_ready(
        history,
        Ok(ready("{\"id\":\"t1\",\"status\":\"completed\"}")),
    );
    let discovered = effects
        .iter()
        .find_map(note)
        .expect("the thread is recorded");
    assert_eq!(
        discovered.get("event").and_then(Value::as_str),
        Some("thread-discovered")
    );
    assert_eq!(
        discovered
            .pointer("/revision/uncertain")
            .and_then(Value::as_bool),
        Some(false)
    );
    // The completion's frame bumped the revision before the read began, so the
    // read's own evidence is current.
    assert_eq!(
        discovered.pointer("/revision/read").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        discovered
            .pointer("/revision/current")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert!(session.recovered.contains("root-1"));
    assert!(session.discovery.reads.is_empty());
}

#[test]
fn output_recovery_bumps_the_revision_and_a_current_read_finishes_it() {
    let mut session = session();
    let effects = session.output_uncertain();
    let started = effects.iter().find_map(note).expect("recovery starts");
    assert_eq!(
        started.get("event").and_then(Value::as_str),
        Some("discovery-start")
    );
    assert_eq!(
        started.get("task").and_then(Value::as_str),
        Some("codex:output-recovery")
    );
    assert!(session.discovery.uncertain.contains("root-1"));
    assert!(!session.recovered.contains("root-1"));
    assert_eq!(session.revisions.get("root-1").copied(), Some(1));
    // The scan runs beside the timers: the loaded list is asked for.
    assert!(
        effects
            .iter()
            .any(|effect| method_of(effect) == Some("thread/loaded/list"))
    );
    let effects = session.read_root("root-1");
    let call = call_of(&effects[0]).expect("the snapshot call");
    let effects = session.settled(call, Ok(&thread_read("root-1", "idle", "")));
    let history = match &effects[0] {
        Effect::ReadHistory { call, .. } => *call,
        _ => panic!("a current read asks for history"),
    };
    let effects = session.history_ready(history, Ok(ready("")));
    let discovered = effects
        .iter()
        .find_map(note)
        .expect("the thread is recorded");
    assert_eq!(
        discovered
            .pointer("/revision/outputRecovery")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        discovered
            .pointer("/revision/uncertain")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert!(!session.discovery.uncertain.contains("root-1"));
    // The scan is still running, so the cycle only ends with it.
    let finished = effects.iter().any(|effect| {
        note(effect).is_some_and(|note| {
            note.get("event").and_then(Value::as_str) == Some("discovery-finished")
        })
    });
    assert!(!finished);
}

#[test]
fn a_revision_that_moved_during_the_read_is_recorded_but_not_uncertain_by_itself() {
    let mut session = session();
    let effects = session.read_root("root-1");
    let call = call_of(&effects[0]).expect("the snapshot call");
    let effects = session.settled(call, Ok(&thread_read("root-1", "idle", "")));
    let history = match &effects[0] {
        Effect::ReadHistory { call, .. } => *call,
        _ => panic!("the read asks for history"),
    };
    // A control-relevant frame lands while history is read.
    session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"root-1\",\"turn\":{\"id\":\"t9\"}}}"),
        None,
        0.0,
    );
    let effects = session.history_ready(history, Ok(ready("")));
    let discovered = effects.iter().find_map(note).expect("the read is recorded");
    assert_eq!(
        discovered.pointer("/revision/read").and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        discovered
            .pointer("/revision/current")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        discovered
            .pointer("/revision/uncertain")
            .and_then(Value::as_bool),
        Some(false)
    );
    // Without output recovery a moved revision is not uncertain: the read is
    // recorded and the fold hydrates nothing from it.
    assert!(!session.discovery.uncertain.contains("root-1"));
    assert!(session.recovered.contains("root-1"));
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, Effect::ArmTimer { .. }))
    );
}

#[test]
fn a_dropped_line_makes_the_output_uncertain_and_recovers_every_known_thread() {
    let mut session = session();
    let effects = session.output_uncertain();
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::ArmTimer { key, .. } if key == "root-1"
    )));
    assert!(session.discovery.output_uncertain());
}

#[test]
fn a_joined_read_that_fails_leaves_its_scan_unfinished_and_retries() {
    let mut session = session();
    session.recovered.insert("root-1".to_owned());
    // The session's own read is running for child-1, and a scan joins it.
    let effects = session.read_root("child-1");
    let running = call_of(&effects[0]).expect("the running read's call");
    let effects = session.reconcile_loaded("discovery:turn-1");
    let call = call_of(&effects[0]).expect("the loaded list call");
    session.settled(call, Ok(&json("{\"data\":[\"child-1\",\"child-2\"]}")));
    let effects = session.settled(running, Err("thread/read refused"));
    // The scan fails with the read: no finish, no further read, and a retry.
    assert!(!effects.iter().any(|effect| {
        note(effect).is_some_and(|note| {
            note.get("event").and_then(Value::as_str) == Some("discovery-finished")
        })
    }));
    assert!(
        !effects
            .iter()
            .any(|effect| method_of(effect) == Some("thread/read"))
    );
    assert!(effects.contains(&Effect::ArmTimer {
        key: "discovery:turn-1".to_owned(),
        ms: 2_000.0
    }));
    let reported = effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Frame { dir, text, .. } if *dir == FrameDir::Stderr => Some(text.clone()),
            _ => None,
        })
        .any(|text| text.contains("thread/read refused"));
    assert!(reported, "the scan reports the read's error once");
}

#[test]
fn a_queue_refresh_counts_every_page_and_reports_the_total() {
    let mut session = session();
    let effects = session.refresh_queue("root-1");
    let call = call_of(&effects[0]).expect("the queue call");
    let effects = session
        .settled(call, Ok(&json("{\"data\":[1,2],\"nextCursor\":\"c2\"}")))
        .into_iter()
        .collect::<Vec<_>>();
    assert_eq!(effects.len(), 1);
    let next = call_of(&effects[0]).expect("the next page");
    let effects = session
        .settled(next, Ok(&json("{\"data\":[3]}")))
        .into_iter()
        .collect::<Vec<_>>();
    let state = effects.iter().find_map(note).expect("the count is a note");
    assert_eq!(
        state.get("event").and_then(Value::as_str),
        Some("queue-state")
    );
    assert_eq!(state.get("count").and_then(Value::as_u64), Some(3));
}

#[test]
fn a_loaded_scan_reads_every_unrecovered_thread_once() {
    let mut session = session();
    session.recovered.insert("root-1".to_owned());
    let effects = session.reconcile_loaded("discovery:turn-1");
    let call = call_of(&effects[0]).expect("the loaded list call");
    let effects = session
        .settled(
            call,
            Ok(&json("{\"data\":[\"root-1\",\"child-1\",\"child-2\"]}")),
        )
        .into_iter()
        .collect::<Vec<_>>();
    // A recovered thread is skipped; the next unrecovered one is read.
    let read = effects
        .iter()
        .find(|effect| method_of(effect) == Some("thread/read"))
        .expect("the scan reads a thread");
    let Effect::Request { params, .. } = read else {
        panic!("the read is a request");
    };
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("child-1")
    );
    let thread = call_of(read).expect("the read's call");
    // A thread with no owned ancestor is dropped by the tree gate, and the
    // scan's continuation is published with that read's own effects.
    let effects = session.settled(thread, Ok(&thread_read("child-1", "idle", "")));
    let next = effects
        .iter()
        .find(|effect| method_of(effect) == Some("thread/read"))
        .expect("the scan continues with the next thread");
    let Effect::Request { params, .. } = next else {
        panic!("the read is a request");
    };
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("child-2")
    );
    let thread = call_of(next).expect("the next read's call");
    let effects = session.settled(thread, Ok(&thread_read("child-2", "idle", "")));
    let finished = effects.iter().find_map(note).expect("the scan ends");
    assert_eq!(
        finished.get("event").and_then(Value::as_str),
        Some("discovery-finished")
    );
}

#[test]
fn a_loaded_scan_joins_a_read_already_in_flight_and_continues_when_it_releases() {
    let mut session = session();
    session.recovered.insert("root-1".to_owned());
    // The session's own read is running for child-1.
    let effects = session.read_root("child-1");
    let running = call_of(&effects[0]).expect("the running read's call");
    let effects = session.reconcile_loaded("discovery:turn-1");
    let call = call_of(&effects[0]).expect("the loaded list call");
    let effects = session
        .settled(call, Ok(&json("{\"data\":[\"child-1\",\"child-2\"]}")))
        .into_iter()
        .collect::<Vec<_>>();
    // The scan waits on the running read instead of reading it twice.
    assert!(
        !effects
            .iter()
            .any(|effect| method_of(effect) == Some("thread/read"))
    );
    let effects = session.settled(running, Ok(&thread_read("child-1", "idle", "")));
    let next = effects
        .iter()
        .find(|effect| method_of(effect) == Some("thread/read"))
        .expect("the scan continues after the joined read");
    let Effect::Request { params, .. } = next else {
        panic!("the read is a request");
    };
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("child-2")
    );
}
