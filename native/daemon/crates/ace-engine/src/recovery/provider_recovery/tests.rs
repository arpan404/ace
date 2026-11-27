// SPDX-License-Identifier: Apache-2.0
//! The Cursor frames and attempt records over a real store: what a send records, how a fresh
//! session sets old frames aside, and how the sweep deletes them a bounded batch at a time.
//!
//! Ported cases (all of `cursor-attempt-record.test.ts`): `:71` the record answers whether Cursor
//! had a send without searching frames; `:90` a new turn drops settled frames a batch per commit;
//! `:115` a restart mid-clean-up reads only the open frame and the new turn; `:129` a fresh
//! session sets old frames aside at once and deletes them in steps; `:163` a send in doubt keeps
//! its evidence through a fresh session; `:190` an earlier build's thread reads from its latest
//! send; `:221` a send older than the 4,096 newest frames is held as attempted; `:243` a crash
//! during that first reopen still leaves the attempt on record; `:267` an idle thread's frames go
//! a batch per sweep; `:281` the sweep never reads every thread's records; `:300` a send 4,095 or
//! 4,096 frames from the newest is read from its frames or held past them.

use super::*;
use crate::repository::testsupport::{header, home};
use ace_store::{Value as Cell, stmt_cache};

const INSERT_FRAME: &str = "INSERT INTO engine_provider_frames VALUES (?,?,?,?)";
const COUNT_FRAMES: &str = "SELECT COUNT(*) AS n FROM engine_provider_frames";

fn frame(kind: &str, body: &str, operation: &str, command: Option<&str>) -> Value {
    ace_json::parse(&format!(
        r#"{{"kind":"{kind}","operationId":"{operation}","segment":0{}{}}}"#,
        command.map_or(String::new(), |command| format!(
            r#","commandId":"{command}""#
        )),
        if body.is_empty() {
            String::new()
        } else {
            format!(r#","body":{body}"#)
        }
    ))
    .unwrap()
}

fn store_frame(conn: &Arc<ace_store::Connection>, seq: i64, kind: &str, operation: &str) -> i64 {
    let data = format!(
        r#"{{"schemaVersion":1,"generation":"host","operationId":"{operation}","commandId":"send-1","segment":0,"kind":"{kind}","body":{{}}}}"#
    );
    let frame = format!(r#"{{"seq":{seq},"t":{seq},"dir":"recv","channel":"sdk","data":{data}}}"#);
    stmt_cache::run(
        conn,
        INSERT_FRAME,
        vec![
            Cell::Text("t".to_owned()),
            Cell::Text("host".to_owned()),
            Cell::Integer(seq),
            Cell::Text(frame),
        ],
    )
    .unwrap()
    .1
}

fn note_frame(
    conn: &Arc<ace_store::Connection>,
    kind: &str,
    body: &str,
    operation: &str,
    command: Option<&str>,
) {
    let data = frame(kind, body, operation, command);
    note(conn, "t", &data).unwrap();
}

fn count(conn: &Arc<ace_store::Connection>) -> i64 {
    stmt_cache::get_row(conn, COUNT_FRAMES, Vec::new())
        .unwrap()
        .and_then(|row| {
            row.get("n")
                .and_then(crate::repository::residency::cell_int)
        })
        .unwrap_or(0)
}

fn restore_kinds(conn: &Arc<ace_store::Connection>) -> Vec<String> {
    let mut seen = Vec::new();
    futures::executor::block_on(restore(conn, "t", &mut |data, _t| {
        seen.push(
            data.get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        );
        Ok(Vec::new())
    }))
    .unwrap();
    seen
}

#[test]
fn whether_cursor_had_an_attempted_send_is_read_from_its_record_not_by_searching_the_threads_frames()
 {
    let conn = home("t", &header("t"));
    assert!(!attempted(&conn, "t", "send-1").unwrap());
    note_frame(
        &conn,
        "send",
        r#"{"input":[],"attemptedAt":1,"runFramed":true}"#,
        "send-1",
        Some("send-1"),
    );
    note_frame(&conn, "run", r#"{"nativeRunId":"run-1"}"#, "send-1", None);
    // Nothing of the send but its attempt and its run's id: no sign yet Cursor had it.
    assert!(attempted(&conn, "t", "send-1").unwrap());
    assert!(!admission_recorded(&conn, "t", "send-1").unwrap());
    assert_eq!(last_admission(&conn, "t").unwrap(), None);
    note_frame(
        &conn,
        "admission",
        r#"{"commandId":"send-1","admitted":false}"#,
        "open",
        Some("open"),
    );
    assert_eq!(
        last_admission(&conn, "t").unwrap(),
        Some((Some("send-1".to_owned()), false))
    );
    note_frame(
        &conn,
        "delta",
        r#"{"type":"text-delta","text":"hello"}"#,
        "send-1",
        None,
    );
    assert!(admission_recorded(&conn, "t", "send-1").unwrap());
    // The thread's frames hold none of this: every answer came from the record.
    assert_eq!(count(&conn), 0);
}

#[test]
fn a_new_turn_on_a_long_cursor_thread_drops_the_settled_turns_frames_a_bounded_batch_per_commit() {
    let conn = home("t", &header("t"));
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 1, "open", "old")),
        false,
    )
    .unwrap();
    for seq in 2..1002 {
        store_frame(&conn, seq, "delta", "old");
    }
    captured(
        &conn,
        "t",
        Some("send"),
        Some(store_frame(&conn, 1002, "send", "new")),
        true,
    )
    .unwrap();
    trim_step(&conn, "t").unwrap();
    // One step deletes a bounded batch, not the thousand frames behind the new turn.
    assert_eq!(count(&conn), 1002 - 256);
    for _ in 0..10 {
        trim_step(&conn, "t").unwrap();
    }
    // In the end: the session's open frame and the new turn's send.
    assert_eq!(count(&conn), 2);
}

#[test]
fn a_restart_in_the_middle_of_that_clean_up_reads_only_the_open_frame_and_the_new_turn() {
    let conn = home("t", &header("t"));
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 1, "open", "old")),
        false,
    )
    .unwrap();
    for seq in 2..600 {
        store_frame(&conn, seq, "delta", "old");
    }
    captured(
        &conn,
        "t",
        Some("send"),
        Some(store_frame(&conn, 600, "send", "new")),
        true,
    )
    .unwrap();
    trim_step(&conn, "t").unwrap();
    assert_eq!(restore_kinds(&conn), vec!["open", "send"]);
}

#[test]
fn a_fresh_session_on_a_thread_with_many_old_frames_sets_them_aside_at_once_and_deletes_them_in_steps()
 {
    let conn = home("t", &header("t"));
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 1, "open", "old")),
        false,
    )
    .unwrap();
    for seq in 2..1200 {
        store_frame(&conn, seq, "delta", "old");
    }
    reset(&conn, "t").unwrap();
    // Nothing of the old session is read again, though its frames are not all gone yet.
    assert_eq!(count(&conn), 1199);
    assert!(restore_kinds(&conn).is_empty());
    // The fresh session's frames start a new record; the old ones go a batch per commit.
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 1200, "open", "fresh")),
        false,
    )
    .unwrap();
    trim_step(&conn, "t").unwrap();
    assert_eq!(count(&conn), 1200 - 256);
    for _ in 0..10 {
        trim_step(&conn, "t").unwrap();
    }
    assert_eq!(count(&conn), 1);
    assert_eq!(restore_kinds(&conn), vec!["open"]);
}

#[test]
fn a_send_in_doubt_keeps_its_delivery_evidence_through_a_fresh_session_after_the_old_frames_are_gone()
 {
    let conn = home("t", &header("t"));
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 1, "open", "old")),
        false,
    )
    .unwrap();
    note_frame(
        &conn,
        "send",
        r#"{"input":[],"attemptedAt":1,"runFramed":true}"#,
        "send-1",
        Some("send-1"),
    );
    store_frame(&conn, 2, "send", "send-1");
    // The saved session can't open again: the thread moves to a fresh one.
    reset(&conn, "t").unwrap();
    for _ in 0..4 {
        trim_step(&conn, "t").unwrap();
    }
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 3, "open", "fresh")),
        false,
    )
    .unwrap();
    for _ in 0..4 {
        trim_step(&conn, "t").unwrap();
    }
    assert_eq!(count(&conn), 1);
    // It was attempted: never taken for a send that never reached Cursor, and never re-sent.
    assert!(attempted(&conn, "t", "send-1").unwrap());
    // Nothing the fresh session reads back settles it: it stays for the person.
    assert_eq!(last_admission(&conn, "t").unwrap(), None);
    // A send of the fresh session has a record of its own, and the old one is kept beside it.
    note_frame(
        &conn,
        "send",
        r#"{"input":[],"attemptedAt":2,"runFramed":true}"#,
        "send-2",
        Some("send-2"),
    );
    assert!(attempted(&conn, "t", "send-2").unwrap());
    assert!(attempted(&conn, "t", "send-1").unwrap());
}

#[test]
fn the_first_reopen_of_a_thread_an_earlier_build_left_reads_from_its_latest_send_not_its_whole_record()
 {
    let conn = home("t", &header("t"));
    // No records of this build: an earlier build's frames, a long settled stretch, then a turn.
    store_frame(&conn, 1, "open", "old");
    for seq in 2..2000 {
        store_frame(&conn, seq, "delta", "old");
    }
    store_frame(&conn, 2000, "send", "new");
    store_frame(&conn, 2001, "delta", "new");
    assert_eq!(restore_kinds(&conn), vec!["open", "send", "delta"]);
    // From then on it is this build's: its settled frames go a batch at a time.
    trim_step(&conn, "t").unwrap();
    assert_eq!(count(&conn), 2001 - 256);
}

#[test]
fn an_earlier_builds_send_older_than_its_newest_4096_frames_is_held_as_attempted_never_sent_again()
{
    let conn = home("t", &header("t"));
    // The send is the thread's second frame; past it, more frames than the newest window holds.
    store_frame(&conn, 1, "open", "old");
    store_frame(&conn, 2, "send", "old");
    for seq in 3..5000 {
        store_frame(&conn, seq, "host-output", "other");
    }
    // Startup asks before any reopen.
    assert!(attempted(&conn, "t", "send-1").unwrap());
    assert!(admission_recorded(&conn, "t", "send-1").unwrap());
    // And after the first reopen has made the thread this build's.
    restore_kinds(&conn);
    assert!(attempted(&conn, "t", "send-1").unwrap());
    assert!(admission_recorded(&conn, "t", "send-1").unwrap());
}

#[test]
fn a_crash_during_an_earlier_builds_first_reopen_still_leaves_its_sends_attempt_on_record() {
    let conn = home("t", &header("t"));
    store_frame(&conn, 1, "open", "old");
    store_frame(&conn, 2, "send", "new");
    store_frame(&conn, 3, "delta", "new");
    // The reopen dies as it replays the send (the daemon was killed there).
    let died = futures::executor::block_on(restore(&conn, "t", &mut |data, _t| {
        if data.get("kind").and_then(Value::as_str) == Some("send") {
            return Err(EngineError::Records("killed".to_owned()));
        }
        Ok(Vec::new())
    }));
    assert!(died.is_err());
    // The next boot still knows the send was attempted and that Cursor's run had output.
    assert!(attempted(&conn, "t", "send-1").unwrap());
    assert!(admission_recorded(&conn, "t", "send-1").unwrap());
}

#[test]
fn an_idle_threads_settled_frames_go_a_bounded_batch_per_sweep_with_no_new_frame_committed() {
    let conn = home("t", &header("t"));
    captured(
        &conn,
        "t",
        Some("open"),
        Some(store_frame(&conn, 1, "open", "old")),
        false,
    )
    .unwrap();
    for seq in 2..700 {
        store_frame(&conn, seq, "delta", "old");
    }
    captured(
        &conn,
        "t",
        Some("send"),
        Some(store_frame(&conn, 700, "send", "new")),
        true,
    )
    .unwrap();
    // The thread goes idle: nothing commits for it any more.
    prune_idle(&conn, 4).unwrap();
    assert_eq!(count(&conn), 700 - 256);
    for _ in 0..4 {
        prune_idle(&conn, 4).unwrap();
    }
    assert_eq!(count(&conn), 2);
}

#[test]
fn the_idle_sweep_finds_threads_with_frames_to_delete_without_reading_every_threads_records() {
    let conn = home("t", &header("t"));
    // Its first sweep, on a store with nothing to prune.
    prune_idle(&conn, 4).unwrap();
    let plan = stmt_cache::all_rows(
        &conn,
        "EXPLAIN QUERY PLAN SELECT thread_id FROM engine_cursor_prune LIMIT ?",
        vec![Cell::Integer(4)],
    )
    .unwrap();
    let details: Vec<String> = plan
        .iter()
        .filter_map(|row| {
            row.get("detail")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
        .collect();
    let joined = details.join("\n");
    // Every thread's records live in engine_state_records: the sweep never scans it.
    assert!(!joined.contains("engine_state_records"), "{joined}");
}

#[test]
fn an_earlier_builds_send_with_4095_newer_frames_is_read_from_its_frames_or_held_past_4096() {
    for (newer, held) in [(4095, false), (4096, true)] {
        let conn = home("t", &header("t"));
        store_frame(&conn, 1, "open", "old");
        store_frame(&conn, 2, "send", "old");
        for seq in 3..3 + newer {
            store_frame(&conn, seq, "host-output", "other");
        }
        assert!(attempted(&conn, "t", "send-1").unwrap(), "{newer}");
        assert_eq!(
            admission_recorded(&conn, "t", "send-1").unwrap(),
            held,
            "{newer}"
        );
        assert_eq!(unknown_attempt(&conn, "t").unwrap(), held, "{newer}");
    }
}
