// SPDX-License-Identifier: Apache-2.0
use super::*;
use media_wire::frame::MediaFrame;

const LIMIT: usize = 100;

/// A writer past its hello, the hello reported written.
fn open() -> Writer {
    let (mut writer, out) = Writer::new(&[7; 32], LIMIT, DRAIN_LIMIT_MS);
    let mut sink = Vec::new();
    writer.written(id_of(&out[0]), &mut sink);
    assert!(sink.is_empty());
    writer
}

fn id_of(action: &Action) -> u64 {
    match action {
        Action::Write { id, .. } => *id,
        other => panic!("not a write: {other:?}"),
    }
}

fn writes(out: &[Action]) -> Vec<Vec<u8>> {
    out.iter()
        .filter_map(|a| match a {
            Action::Write { bytes, .. } => Some(bytes.as_slice().to_vec()),
            _ => None,
        })
        .collect()
}

fn kinds(out: &[Action]) -> Vec<u8> {
    writes(out)
        .iter()
        .map(|b| MediaFrame::decode(b).map_or(0, |f| f.kind))
        .collect()
}

fn unit(writer: &mut Writer, now: u64, len: usize, key: bool) -> Vec<Action> {
    let mut out = Vec::new();
    assert!(writer.unit(now, vec![key as u8; len], key, &mut out));
    out
}

fn ack_all(writer: &mut Writer, out: &[Action]) -> Vec<Action> {
    let mut next = Vec::new();
    for action in out {
        if let Action::Write { id, .. } = action {
            writer.written(*id, &mut next);
        }
    }
    next
}

#[test]
fn the_hello_goes_first_with_the_token() {
    let (writer, out) = Writer::new(&[7; 32], LIMIT, DRAIN_LIMIT_MS);
    let frame = MediaFrame::decode(&writes(&out)[0]).unwrap();
    assert_eq!((frame.kind, frame.payload), (5, vec![7; 32]));
    assert!(matches!(
        out[0],
        Action::Write {
            bytes: Bytes::Hello(_),
            ..
        }
    ));
    assert_eq!(writer.state(), WriterState::Open);
}

#[test]
fn units_are_written_in_order_and_none_is_coalesced() {
    let mut writer = open();
    let mut all = Vec::new();
    for (i, key) in [true, false, false].into_iter().enumerate() {
        let out = unit(&mut writer, 0, 10 + i, key);
        all.extend(writes(&out));
    }
    assert_eq!(
        all.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![10, 11, 12]
    );
}

#[test]
fn a_delta_that_does_not_fit_drops_to_the_next_keyframe_asked_for_once() {
    let mut writer = open();
    let first = unit(&mut writer, 0, 60, true);
    // 60 queued + 50 > 100: dropped, keyframe asked for; the deadline is armed.
    let out = unit(&mut writer, 0, 50, false);
    assert_eq!(out, vec![Action::Keyframe]);
    // Further deltas are dropped silently while waiting for room.
    assert!(unit(&mut writer, 1, 50, false).is_empty());
    // Room comes back: nothing was waiting, so later deltas still wait for a keyframe.
    assert!(ack_all(&mut writer, &first).is_empty());
    assert!(unit(&mut writer, 2, 10, false).is_empty());
    let key = unit(&mut writer, 3, 10, true);
    assert_eq!(writes(&key).len(), 1);
    assert_eq!(writes(&unit(&mut writer, 4, 10, false)).len(), 1);
}

#[test]
fn a_keyframe_that_does_not_fit_waits_newest_only_until_there_is_room() {
    let mut writer = open();
    let first = unit(&mut writer, 0, 90, true);
    assert!(writes(&unit(&mut writer, 0, 20, true)).is_empty());
    assert!(writes(&unit(&mut writer, 0, 30, true)).is_empty());
    let room = ack_all(&mut writer, &first);
    assert_eq!(writes(&room), vec![vec![1; 30]]);
}

#[test]
fn an_empty_socket_takes_a_keyframe_bigger_than_the_budget() {
    let mut writer = open();
    assert_eq!(writes(&unit(&mut writer, 0, 500, true)).len(), 1);
}

#[test]
fn a_backlog_that_stays_too_big_past_the_drain_limit_is_one_cut() {
    let mut writer = open();
    // An empty socket took a keyframe past the budget; nothing is reported written.
    let _held = unit(&mut writer, 0, 500, true);
    unit(&mut writer, 10, 20, false);
    let mut out = Vec::new();
    writer.tick(10 + DRAIN_LIMIT_MS - 1, &mut out);
    assert!(out.is_empty());
    writer.tick(10 + DRAIN_LIMIT_MS, &mut out);
    assert_eq!(out, vec![Action::Destroy, Action::Cut(Cut::DrainLimit)]);
    // Final: nothing else is reported, nothing written.
    let mut more = Vec::new();
    writer.tick(u64::MAX, &mut more);
    writer.write_failed(&mut more);
    writer.socket_closed(&mut more);
    writer.finish(0, &mut more);
    assert!(!writer.unit(0, vec![1], true, &mut more));
    assert!(more.is_empty());
    assert_eq!(writer.state(), WriterState::Cut);
}

#[test]
fn finish_writes_the_end_frame_and_ends_only_once_it_is_written() {
    let mut writer = open();
    let mut out = Vec::new();
    writer.finish(0, &mut out);
    assert_eq!(kinds(&out), vec![4]);
    assert_eq!(writer.state(), WriterState::Finishing { end_written: true });
    assert!(writer.closed());
    let done = ack_all(&mut writer, &out);
    assert_eq!(done, vec![Action::Shutdown, Action::Ended]);
    assert_eq!(writer.state(), WriterState::Ended);
}

#[test]
fn queued_units_go_before_the_end_frame() {
    let mut writer = open();
    let mut out = unit(&mut writer, 0, 10, true);
    out.extend(unit(&mut writer, 0, 10, false));
    writer.finish(0, &mut out);
    assert_eq!(kinds(&out), vec![0, 0, 4]);
    // The end frame's report comes after the units': ended only then.
    let ids: Vec<u64> = out
        .iter()
        .filter(|a| matches!(a, Action::Write { .. }))
        .map(id_of)
        .collect();
    let mut done = Vec::new();
    writer.written(ids[0], &mut done);
    writer.written(ids[1], &mut done);
    assert!(done.is_empty());
    writer.written(ids[2], &mut done);
    assert_eq!(done, vec![Action::Shutdown, Action::Ended]);
}

#[test]
fn a_waiting_keyframe_goes_before_the_end_frame_once_there_is_room() {
    let mut writer = open();
    let first = unit(&mut writer, 0, 90, true);
    unit(&mut writer, 0, 30, true);
    let mut out = Vec::new();
    writer.finish(5, &mut out);
    assert!(out.is_empty());
    let room = ack_all(&mut writer, &first);
    assert_eq!(writes(&room)[0], vec![1; 30]);
    assert_eq!(kinds(&room)[1], 4);
}

#[test]
fn the_finish_deadline_stays_armed_until_the_end_frame_is_written() {
    let mut writer = open();
    let mut out = Vec::new();
    writer.finish(100, &mut out);
    // The end frame was handed over but never reported: still a cut at the deadline.
    let mut cut = Vec::new();
    writer.tick(100 + DRAIN_LIMIT_MS, &mut cut);
    assert_eq!(cut, vec![Action::Destroy, Action::Cut(Cut::DrainLimit)]);
    // A late report changes nothing.
    assert!(ack_all(&mut writer, &out).is_empty());
    assert_eq!(writer.state(), WriterState::Cut);
}

#[test]
fn a_second_finish_does_nothing() {
    let mut writer = open();
    let mut out = Vec::new();
    writer.finish(0, &mut out);
    let mut again = Vec::new();
    writer.finish(1_000, &mut again);
    assert!(again.is_empty());
    // The deadline is still the first finish's.
    writer.tick(DRAIN_LIMIT_MS, &mut again);
    assert_eq!(again, vec![Action::Destroy, Action::Cut(Cut::DrainLimit)]);
}

#[test]
fn every_failure_is_one_cut_and_close_is_never_reported() {
    type Event = fn(&mut Writer, &mut Vec<Action>);
    let events: [(Event, Option<Cut>); 3] = [
        (|w, o| w.write_failed(o), Some(Cut::WriteFailed)),
        (|w, o| w.socket_closed(o), Some(Cut::Closed)),
        (|w, o| w.close(o), None),
    ];
    for (finishing, (event, cut)) in [false, true]
        .into_iter()
        .flat_map(|f| events.iter().map(move |e| (f, *e)))
    {
        let mut writer = open();
        let mut out = Vec::new();
        if finishing {
            writer.finish(0, &mut out);
            out.clear();
        }
        event(&mut writer, &mut out);
        event(&mut writer, &mut out);
        let mut expected = vec![Action::Destroy];
        expected.extend(cut.map(Action::Cut));
        assert_eq!(out, expected, "finishing {finishing}");
        assert_eq!(writer.state(), WriterState::Cut);
    }
}

#[test]
fn an_ended_writer_is_final() {
    let mut writer = open();
    let mut out = Vec::new();
    writer.finish(0, &mut out);
    ack_all(&mut writer, &out);
    let mut after = Vec::new();
    writer.socket_closed(&mut after);
    writer.write_failed(&mut after);
    writer.close(&mut after);
    writer.tick(u64::MAX, &mut after);
    assert!(!writer.unit(0, vec![1], true, &mut after));
    assert!(after.is_empty());
    assert_eq!(writer.state(), WriterState::Ended);
}

#[test]
fn a_report_out_of_order_is_ignored() {
    let mut writer = open();
    let a = unit(&mut writer, 0, 60, true);
    let b = unit(&mut writer, 0, 30, false);
    let mut out = Vec::new();
    writer.written(id_of(&b[0]), &mut out);
    assert_eq!(writer.backlog(), 90);
    writer.written(id_of(&a[0]), &mut out);
    writer.written(id_of(&b[0]), &mut out);
    assert_eq!(writer.backlog(), 0);
}

#[test]
fn room_found_at_the_deadline_is_room_and_no_cut() {
    let mut writer = open();
    unit(&mut writer, 0, 90, true);
    // Dropped (90 + 20 > 100), though the backlog itself is within the limit.
    assert_eq!(unit(&mut writer, 0, 20, false), vec![Action::Keyframe]);
    let mut out = Vec::new();
    writer.tick(DRAIN_LIMIT_MS, &mut out);
    assert!(out.is_empty());
    assert_eq!(writer.state(), WriterState::Open);
}
