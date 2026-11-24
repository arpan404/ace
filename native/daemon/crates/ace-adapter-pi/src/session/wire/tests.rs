// SPDX-License-Identifier: Apache-2.0
//! The Pi wire's input/output tables (E3-pi.1).

use ace_json::{JsString, Map, Value};
use ace_supervisor::budget::DropPhase;

use super::*;

fn new_wire() -> PiWire {
    PiWire::new(PiWireConfig {
        control_secret: "cs".to_owned(),
        lease_bearer: Some("lease-bearer-xyz".to_owned()),
    })
}

fn names(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .map(|effect| match effect {
            Effect::Frame { dir, .. } => format!("frame:{dir:?}"),
            Effect::Write { .. } => "write".to_owned(),
            Effect::Settle { id, .. } => format!("settle:{id}"),
            Effect::ArmTimer { key, .. } => format!("arm:{key}"),
            Effect::CancelTimer { key } => format!("cancel:{key}"),
            Effect::Fatal { message } => format!("fatal:{message}"),
            Effect::Drained => "drained".to_owned(),
        })
        .collect()
}

fn frames(effects: &[Effect]) -> Vec<(FrameDir, String)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Frame { dir, text, .. } => Some((*dir, text.clone())),
            _ => None,
        })
        .collect()
}

fn settles(effects: &[Effect]) -> Vec<(u64, Result<String, PiError>)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Settle { id, result } => Some((*id, result.clone())),
            _ => None,
        })
        .collect()
}

fn armed(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::ArmTimer { key, .. } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

fn line_of(request: Result<Vec<Effect>, PiError>) -> String {
    let effects = request.expect("request taken");
    let Effect::Write { wire } = effects.last().expect("a write") else {
        panic!("last effect is not a write");
    };
    String::from_utf8(wire[..wire.len() - 1].to_vec()).expect("utf-8")
}

/// A `write()` body whose JSON line is exactly `line_bytes` long.
fn padded(line_bytes: usize) -> Map {
    let mut map = Map::new();
    let pad = "a".repeat(line_bytes - "{\"p\":\"\"}".len());
    map.insert("p", Value::String(JsString::from(pad)));
    map
}

fn js(text: &str) -> JsString {
    match ace_json::parse(text).expect("json") {
        Value::String(id) => id,
        _ => panic!("not a string"),
    }
}

#[test]
fn request_capacity_is_64_and_a_refusal_uses_no_number() {
    let mut wire = new_wire();
    for id in 1..=64u64 {
        let line = line_of(wire.request("x", &Map::new(), id));
        assert!(line.ends_with(&format!("\"id\":\"ace-{id}\"}}")));
    }
    assert_eq!(
        wire.request("x", &Map::new(), 65).expect_err("capacity"),
        PiError::refused(Refused::Capacity)
    );
    // Only a response frees a pending slot; the refused capacity used no
    // number, so the next command is 65, not 66.
    wire.stdin_written();
    let response = r#"{"type":"response","id":"ace-1","command":"x","success":true}"#;
    assert_eq!(frames(&wire.stdout_line(response)).len(), 1);
    assert!(line_of(wire.request("x", &Map::new(), 66)).ends_with("\"id\":\"ace-65\"}"));
}

#[test]
fn an_oversized_command_uses_its_number_and_leaves_no_state() {
    let mut wire = new_wire();
    let mut map = Map::new();
    map.insert(
        "p",
        Value::String(JsString::from("a".repeat(MAX_FRAME_BYTES))),
    );
    assert_eq!(
        wire.request("x", &map, 1).expect_err("frame limit"),
        PiError::refused(Refused::FrameLimit)
    );
    assert!(wire.pending.is_empty());
    assert!(wire.writes.is_empty());
    assert_eq!(wire.queued_bytes, 0);
    assert!(line_of(wire.request("x", &Map::new(), 2)).ends_with("\"id\":\"ace-2\"}"));
}

#[test]
fn frame_and_queue_bounds_are_exact() {
    let mut wire = new_wire();
    let exact = padded(MAX_FRAME_BYTES);
    let effects = wire.write(&exact, 1, false).expect("exactly 1 MiB");
    let Effect::Write { wire: bytes } = &effects[0] else {
        panic!("write");
    };
    assert_eq!(bytes.len(), MAX_FRAME_BYTES + 1);
    assert_eq!(
        wire.write(&padded(MAX_FRAME_BYTES + 1), 2, false)
            .expect_err("frame limit"),
        PiError::refused(Refused::FrameLimit)
    );

    let mut wire = new_wire();
    assert!(
        wire.write(&padded(MAX_QUEUED_BYTES / 2 - 1), 1, false)
            .is_ok()
    );
    assert!(
        wire.write(&padded(MAX_QUEUED_BYTES / 2 - 1), 2, false)
            .is_ok()
    );
    assert_eq!(wire.queued_bytes, MAX_QUEUED_BYTES);
    let refused = wire
        .write(&padded(MAX_QUEUED_BYTES / 2 - 1), 3, false)
        .expect("settles through the queue");
    assert_eq!(
        settles(&refused),
        vec![(3, Err(PiError::uncertain(Uncertain::WriteQueueFull)))]
    );
    assert_eq!(names(&refused), vec!["settle:3"]);
    assert_eq!(wire.writes.len(), 2);
    wire.stdin_written();
    let readmitted = wire
        .write(&padded(MAX_QUEUED_BYTES / 2 - 1), 4, false)
        .expect("the freed charge admits the write");
    assert_eq!(names(&readmitted), vec!["write"]);
    assert_eq!(wire.queued_bytes, MAX_QUEUED_BYTES);
    assert_eq!(wire.writes.len(), 2);
}

#[test]
fn a_request_settles_once_across_ack_response_and_close() {
    let mut wire = new_wire();
    let request = wire.request("x", &Map::new(), 7).expect("request");
    assert_eq!(names(&request), vec!["arm:deadline:ace-1", "write"]);
    let sent = wire.stdin_written();
    assert_eq!(
        names(&sent),
        vec!["frame:Send"],
        "a request does not settle on its write"
    );
    let response =
        r#"{"type":"response","id":"ace-1","command":"x","success":true,"data":{"a":1}}"#;
    let effects = wire.stdout_line(response);
    assert_eq!(
        names(&effects),
        vec!["frame:Recv", "cancel:deadline:ace-1", "settle:7"]
    );
    assert_eq!(settles(&effects), vec![(7, Ok("{\"a\":1}".to_owned()))]);
    assert!(settles(&wire.stdout_line(response)).is_empty());
    assert!(settles(&wire.close()).is_empty());
}

#[test]
fn a_write_refusal_settles_and_releases_the_newest_charge_once() {
    let mut wire = new_wire();
    wire.write(&padded(16), 1, false).expect("first");
    wire.write(&padded(16), 2, false).expect("second");
    let charge = wire.writes.back().expect("newest").charge;
    let before = wire.queued_bytes;
    let effects = wire.write_refused();
    assert_eq!(wire.queued_bytes, before - charge);
    assert_eq!(
        settles(&effects),
        vec![(2, Err(PiError::uncertain(Uncertain::StdinClosed)))]
    );
    assert_eq!(
        names(&effects).last().map(String::as_str),
        Some("fatal:JSON-RPC stdin closed")
    );
    let finished = wire.finish();
    assert_eq!(
        settles(&finished),
        vec![(1, Err(PiError::uncertain(Uncertain::Closed)))],
        "the remaining write settles once, at the barrier"
    );
    assert_eq!(wire.queued_bytes, 0);
    assert!(matches!(finished.last(), Some(Effect::Drained)));
}

#[test]
fn close_settles_every_reservation_once_and_zeroes_the_budget() {
    let mut wire = new_wire();
    wire.request("x", &Map::new(), 1).expect("request");
    wire.stdin_written();
    wire.request("y", &Map::new(), 2).expect("request");
    wire.write(&padded(16), 3, true).expect("dialog answer");
    let effects = wire.close();
    assert_eq!(
        settles(&effects)
            .iter()
            .map(|(id, _)| *id)
            .collect::<Vec<_>>(),
        vec![3, 1, 2]
    );
    assert!(
        effects
            .iter()
            .filter(|effect| matches!(effect, Effect::Settle { .. }))
            .all(|effect| matches!(effect, Effect::Settle { result: Err(_), .. }))
    );
    assert_eq!(wire.queued_bytes, 0);
    assert!(settles(&wire.close()).is_empty());
}

#[test]
fn dialog_effects_keep_their_order() {
    let mut wire = new_wire();
    wire.request("prompt", &Map::new(), 1).expect("request");
    wire.stdin_written();
    let effects = wire.stdout_line(
        r#"{"type":"extension_ui_request","id":"d1","method":"select","timeout":500}"#,
    );
    assert_eq!(
        names(&effects),
        vec!["frame:Recv", "arm:dialog:d1", "cancel:deadline:ace-1"]
    );
    assert_eq!(wire.dialog_count(), 1);
    let (taken, effects) = wire.take_dialog(&JsString::from("d1"));
    assert!(taken);
    assert_eq!(names(&effects), vec!["cancel:dialog:d1"]);
    assert!(!wire.take_dialog(&JsString::from("d1")).0);
}

#[test]
fn dialog_expiry_resumes_deadlines_before_its_note() {
    let mut wire = new_wire();
    wire.request("prompt", &Map::new(), 1).expect("request");
    wire.stdin_written();
    wire.stdout_line(
        r#"{"type":"extension_ui_request","id":"d1","method":"select","timeout":500}"#,
    );
    let effects = wire.timer("dialog:d1");
    assert_eq!(names(&effects), vec!["arm:deadline:ace-1", "frame:Note"]);
    assert_eq!(
        frames(&effects),
        vec![(
            FrameDir::Note,
            r#"{"type":"dialog_expired","id":"d1"}"#.to_owned()
        )]
    );
    assert!(wire.timer("dialog:d1").is_empty());
}

#[test]
fn a_successful_answer_write_resumes_deadlines_when_no_dialog_is_left() {
    let mut wire = new_wire();
    wire.request("prompt", &Map::new(), 1).expect("request");
    wire.stdin_written();
    wire.stdout_line(r#"{"type":"extension_ui_request","id":"d1","method":"input"}"#);
    let (taken, _) = wire.take_dialog(&JsString::from("d1"));
    assert!(taken);
    let answer = wire.write(&padded(16), 9, true).expect("answer");
    assert_eq!(names(&answer), vec!["write"]);
    assert_eq!(
        names(&wire.stdin_written()),
        vec!["frame:Send", "settle:9", "arm:deadline:ace-1"]
    );
}

#[test]
fn an_unparseable_blocking_dialog_is_fatal_after_its_frame() {
    let mut wire = new_wire();
    let effects = wire.stdout_line(r#"{"type":"extension_ui_request","id":5,"method":"select"}"#);
    assert_eq!(names(&effects), vec!["frame:Recv", "fatal:Pi RPC closed"]);
    assert_eq!(wire.dialog_count(), 0);
}

#[test]
fn a_duplicate_dialog_id_is_not_added_twice() {
    let mut wire = new_wire();
    let line = r#"{"type":"extension_ui_request","id":"d1","method":"select"}"#;
    assert_eq!(names(&wire.stdout_line(line)), vec!["frame:Recv"]);
    assert_eq!(names(&wire.stdout_line(line)), vec!["frame:Recv"]);
    assert_eq!(wire.dialog_count(), 1);
}

#[test]
fn rollback_acknowledgement_sets_and_clears_the_result() {
    let mut wire = new_wire();
    wire.expect_rollback("r1".to_owned());
    let notify = r#"{"type":"extension_ui_request","method":"notify","message":"{\"type\":\"ace_rollback\",\"id\":\"r1\",\"success\":true}"}"#;
    assert_eq!(names(&wire.stdout_line(notify)), vec!["frame:Recv"]);
    assert_eq!(wire.rollback_result(), Some(true));
    wire.clear_rollback();
    assert_eq!(wire.rollback_result(), None);
}

#[test]
fn chunked_stdout_keeps_crlf_lf_and_unknown_fields() {
    let mut wire = new_wire();
    let line = r#"{"type":"future","secret":"cs","deep":{"a":[1,2]}}"#;
    let input = format!("{line}\r\n{}\n", r#"{"type":"tick"}"#);
    let mut effects = Vec::new();
    for chunk in input.as_bytes().chunks(7) {
        effects.extend(wire.stdout_bytes(chunk));
    }
    assert_eq!(
        frames(&effects),
        vec![
            (FrameDir::Recv, line.replace("cs", "<ACE_CONTROL>")),
            (FrameDir::Recv, r#"{"type":"tick"}"#.to_owned()),
        ]
    );
    assert_eq!(names(&wire.finish()), vec!["cancel:notes", "drained"]);
}

#[test]
fn an_unterminated_stdout_record_is_fatal_at_drain() {
    let mut wire = new_wire();
    assert!(frames(&wire.stdout_bytes(br#"{"type":"tick"}"#)).is_empty());
    assert_eq!(
        names(&wire.finish()),
        vec!["fatal:Incomplete JSONL record", "cancel:notes", "drained"]
    );
}

#[test]
fn stderr_frames_on_bare_cr_and_flushes_its_tail_at_drain() {
    let mut wire = new_wire();
    let mut effects = Vec::new();
    for chunk in [&b"a\r"[..], b"b", b"\n"] {
        effects.extend(wire.stderr_bytes(chunk));
    }
    assert_eq!(
        frames(&effects),
        vec![
            (FrameDir::Stderr, "\"a\"".to_owned()),
            (FrameDir::Stderr, "\"b\"".to_owned()),
        ]
    );
    assert!(frames(&wire.stderr_bytes(b"tail")).is_empty());
    let finished = wire.finish();
    assert_eq!(
        names(&finished),
        vec!["frame:Stderr", "cancel:notes", "drained"],
        "the tail frame comes before Drained"
    );
    assert_eq!(
        frames(&finished),
        vec![(FrameDir::Stderr, "\"tail\"".to_owned())]
    );
}

#[test]
fn stderr_drops_note_at_most_once_per_interval() {
    let mut wire = new_wire();
    let drop = DroppedLine {
        bytes: 2_000_000,
        prefix: "x".to_owned(),
        phase: DropPhase::Complete,
    };
    assert_eq!(
        names(&wire.stderr_dropped(drop.clone())),
        vec!["frame:Stderr", "arm:notes"]
    );
    assert_eq!(
        frames(&wire.stderr_dropped(drop.clone())),
        Vec::<(FrameDir, String)>::new()
    );
    assert_eq!(
        frames(&wire.stderr_dropped(drop)),
        Vec::<(FrameDir, String)>::new()
    );
    let effects = wire.timer("notes");
    assert_eq!(names(&effects), vec!["frame:Stderr", "arm:notes"]);
    assert_eq!(
        frames(&effects),
        vec![(
            FrameDir::Stderr,
            "\"ace dropped 2 stderr lines, 4000000 bytes in total\"".to_owned()
        )]
    );
}

#[test]
fn stdout_crlf_split_across_chunks_stays_one_line() {
    let mut wire = new_wire();
    assert!(frames(&wire.stdout_bytes(br#"{"type":"a"}"#)).is_empty());
    assert!(frames(&wire.stdout_bytes(b"\r")).is_empty());
    assert_eq!(
        frames(&wire.stdout_bytes(b"\n")),
        vec![(FrameDir::Recv, r#"{"type":"a"}"#.to_owned())]
    );
}

#[test]
fn payload_admission_rejects_before_a_frame_or_settlement() {
    let mut wire = new_wire();
    wire.request("x", &Map::new(), 1).expect("request");
    let oversized = format!("{{}}{}", " ".repeat(MAX_PAYLOAD_BYTES));
    assert_eq!(
        names(&wire.stdout_line(&oversized)),
        vec!["fatal:Provider payload exceeds byte limit"]
    );
    assert_eq!(
        names(&wire.stdout_line("{")),
        vec!["fatal:Invalid Pi frame"]
    );
    // The request is untouched until the facade closes the session.
    assert_eq!(
        settles(&wire.close()),
        vec![(1, Err(PiError::uncertain(Uncertain::Closed)))]
    );
}

#[test]
fn unknown_events_deeper_than_a_typed_decode_are_admitted() {
    let mut wire = new_wire();
    let mut line = String::from(r#"{"type":"future","v":"#);
    line.push_str(&"[".repeat(300));
    line.push('1');
    line.push_str(&"]".repeat(300));
    line.push('}');
    assert_eq!(names(&wire.stdout_line(&line)), vec!["frame:Recv"]);
}

#[test]
fn payload_admission_counts_nodes_exactly() {
    fn response(items: usize) -> String {
        let mut data = String::from("[");
        for item in 0..items {
            if item > 0 {
                data.push(',');
            }
            data.push('1');
        }
        data.push(']');
        format!(r#"{{"type":"response","id":"ace-1","command":"x","success":true,"data":{data}}}"#)
    }
    // The root and its five fields, then one node per item.
    for (items, accepted) in [(32_762usize, true), (32_763, false)] {
        let mut wire = new_wire();
        wire.request("x", &Map::new(), 1).expect("request");
        let effects = wire.stdout_line(&response(items));
        if accepted {
            assert_eq!(settles(&effects).len(), 1);
        } else {
            assert_eq!(
                names(&effects),
                vec!["fatal:Provider payload exceeds structural limit"]
            );
            assert_eq!(
                settles(&wire.close()),
                vec![(1, Err(PiError::uncertain(Uncertain::Closed)))]
            );
        }
    }
}

fn nested(depth: usize) -> String {
    format!("{}1{}", "[".repeat(depth), "]".repeat(depth))
}

#[test]
fn a_30_000_deep_payload_is_admitted_in_one_linear_pass() {
    let depth = 30_000usize;
    let payload = nested(depth);
    let mut wire = new_wire();
    let line = format!(r#"{{"type":"future","v":{payload}}}"#);
    let start = std::time::Instant::now();
    assert_eq!(names(&wire.stdout_line(&line)), vec!["frame:Recv"]);
    let elapsed = start.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(1000),
        "admission must not rescan subtrees: {elapsed:?}"
    );
}

#[test]
fn a_deep_dialog_keeps_its_raw_json_for_peek() {
    let depth = 30_000usize;
    let mut wire = new_wire();
    let line = format!(
        r#"{{"type":"extension_ui_request","id":"d1","method":"select","deep":{}}}"#,
        nested(depth)
    );
    assert_eq!(names(&wire.stdout_line(&line)), vec!["frame:Recv"]);
    let peeked = wire.peek_dialog(&JsString::from("d1")).expect("pending");
    let value = ace_json::parse(&peeked).expect("raw text is valid JSON");
    let map = value.as_object().expect("an object");
    assert!(
        matches!(map.get("deep"), Some(Value::Array(_))),
        "the deep field is not null"
    );
}

#[test]
fn deep_response_data_settles_as_its_raw_json() {
    let depth = 30_000usize;
    let mut wire = new_wire();
    wire.request("x", &Map::new(), 1).expect("request");
    let response = format!(
        r#"{{"type":"response","id":"ace-1","command":"x","success":true,"data":{}}}"#,
        nested(depth)
    );
    let effects = wire.stdout_line(&response);
    let (_, result) = settles(&effects).pop().expect("settled");
    let text = result.expect("deep data settles");
    let value = ace_json::parse(&text).expect("raw text is valid JSON");
    assert!(matches!(value, Value::Array(_)), "data is not null");
}

#[test]
fn admission_counts_only_object_members_json_parse_keeps() {
    // 33,000 raw values, but JSON.parse keeps one member: 33,001 nodes raw,
    // seven after the duplicate key collapses.
    let duplicates = format!("{{{}}}", vec![r#""k":1"#; 33_000].join(","));
    let mut wire = new_wire();
    wire.request("x", &Map::new(), 1).expect("request");
    let response = format!(
        r#"{{"type":"response","id":"ace-1","command":"x","success":true,"data":{duplicates}}}"#
    );
    let effects = wire.stdout_line(&response);
    assert_eq!(
        settles(&effects).len(),
        1,
        "the frame is admitted and settles"
    );
}

#[test]
fn lone_surrogate_dialog_ids_stay_distinct() {
    let mut wire = new_wire();
    let first = wire.stdout_line(
        r#"{"type":"extension_ui_request","id":"\ud800","method":"select","timeout":500}"#,
    );
    let second = wire.stdout_line(
        r#"{"type":"extension_ui_request","id":"\ud801","method":"select","timeout":500}"#,
    );
    assert_eq!(wire.dialog_count(), 2);
    let keys_first = armed(&first);
    let keys_second = armed(&second);
    assert_ne!(keys_first, keys_second);
    let id_first = js(r#""\ud800""#);
    let id_second = js(r#""\ud801""#);
    assert_eq!(dialogs::dialog_id(&keys_first[0]), Some(id_first.clone()));
    assert!(wire.peek_dialog(&id_first).is_some());
    assert!(wire.peek_dialog(&id_second).is_some());
    let expired = wire.timer(&keys_first[0]);
    assert_eq!(wire.dialog_count(), 1);
    assert_eq!(
        frames(&expired),
        vec![(
            FrameDir::Note,
            r#"{"type":"dialog_expired","id":"\ud800"}"#.to_owned()
        )]
    );
    assert!(!wire.take_dialog(&id_first).0);
    assert!(wire.take_dialog(&id_second).0);
}
