// SPDX-License-Identifier: Apache-2.0
//! Sources, ingest connections, epochs and the recording barrier.
use super::super::recorder::{RecordSpec, Recorder, Recorders};
use super::super::*;
use super::*;
use media_wire::control::{FromMedia, Part, Status};
use media_wire::frame::MediaFrame;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[test]
fn an_ingest_connection_stays_open_only_after_a_hello_with_an_unused_token_of_an_open_source() {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 9);
    assert_eq!(
        closes(&ingest(&mut engine, 1, unit(1, true), NOW)),
        [1],
        "unit before hello"
    );
    assert_eq!(closes(&hello(&mut engine, 2, 8)), [2], "wrong token");
    assert!(closes(&hello(&mut engine, 3, 9)).is_empty(), "right token");
    // A second hello on an admitted connection is a protocol error.
    let again = ingest(&mut engine, 3, frame(5, 0, 0, vec![9; 32]), NOW);
    assert_eq!(closes(&again), [3]);
    // Tokens are single use.
    assert_eq!(closes(&hello(&mut engine, 4, 9)), [4]);
    // A closed source's token is gone with it.
    open_tab(&mut engine, "s2", 2, 3);
    send(
        &mut engine,
        json!({ "type": "source.close", "source": "s2" }),
        &[],
        NOW,
    );
    assert_eq!(closes(&hello(&mut engine, 5, 3)), [5]);
}

#[test]
fn a_source_reports_starting_then_playing_at_its_first_unit_retrying_when_its_producer_drops_and_ended_at_its_end()
 {
    let mut engine = engine();
    let opened = open_tab(&mut engine, "s1", 1, 9);
    assert_eq!(statuses(&opened), [("s1".into(), Status::Starting, None)]);
    assert!(statuses(&hello(&mut engine, 1, 9)).is_empty());
    let first = ingest(&mut engine, 1, unit(1, true), NOW);
    assert_eq!(statuses(&first), [("s1".into(), Status::Playing, None)]);
    assert!(statuses(&ingest(&mut engine, 1, unit(1, false), NOW)).is_empty());

    engine.ingest_closed(1, NOW);
    let dropped: Vec<Effect> = engine.effects().collect();
    assert!(matches!(
        dropped.as_slice(),
        [Effect::Normal(FromMedia::SourceStatus {
            status: Status::Retrying,
            attempts: Some(1),
            ..
        })]
    ));

    // The daemon reopens the source with a fresh token; the producer streams again and ends.
    open_tab(&mut engine, "s1", 2, 4);
    hello(&mut engine, 2, 4);
    ingest(&mut engine, 2, unit(1, true), NOW);
    let ended = ingest(&mut engine, 2, frame(4, 0, 0, Vec::new()), NOW);
    assert_eq!(statuses(&ended), [("s1".into(), Status::Ended, None)]);
    assert_eq!(closes(&ended), [2]);
}

#[test]
fn a_reused_handle_and_an_origin_without_a_reader_end_the_source_at_once() {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 9);
    let reused = open_tab(&mut engine, "s2", 1, 8);
    assert_eq!(
        statuses(&reused),
        [("s2".into(), Status::Ended, Some("handle-reused".into()))]
    );
    let simulator = send(
        &mut engine,
        json!({ "type": "source.open", "source": "sim", "handle": 2, "epoch": 0,
                "origin": { "kind": "simulator", "streamUrl": "http://x", "stillUrl": "http://y" } }),
        &[1; 32],
        NOW,
    );
    assert_eq!(
        statuses(&simulator),
        [
            ("sim".into(), Status::Starting, None),
            (
                "sim".into(),
                Status::Ended,
                Some("reader-unavailable".into())
            )
        ]
    );
}

#[test]
fn source_epochs_are_acknowledged_on_the_priority_lane() {
    let mut engine = engine();
    send(
        &mut engine,
        json!({ "type": "source.open", "source": "p", "handle": 1, "epoch": 3,
                "origin": { "kind": "tab-pictures" } }),
        &[1; 32],
        NOW,
    );
    let applied = send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "p", "seq": 0, "epoch": 4, "followsPrivate": true }),
        &[],
        NOW,
    );
    assert!(matches!(
        applied.as_slice(),
        [Effect::Priority(FromMedia::EpochApplied { epoch: 4, .. })]
    ));
    // An unknown source has nothing to apply.
    let unknown = send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "q", "seq": 0, "epoch": 4, "followsPrivate": false }),
        &[],
        NOW,
    );
    assert!(unknown.is_empty());
}

#[test]
fn sources_past_the_limit_end_at_once_with_the_limit_as_the_reason() {
    let mut engine = engine();
    for handle in 0..crate::engine::sources::MAX_SOURCES as u32 {
        open_tab(&mut engine, &format!("s{handle}"), handle, 1);
    }
    let refused = open_tab(&mut engine, "one-more", 100_000, 2);
    assert_eq!(
        statuses(&refused),
        [(
            "one-more".into(),
            Status::Ended,
            Some("source-limit".into())
        )]
    );
    assert_eq!(
        engine.counts().sources,
        crate::engine::sources::MAX_SOURCES as u64
    );
}

type Log = Arc<Mutex<Vec<String>>>;

struct FakeRecorder(Log);

impl Recorder for FakeRecorder {
    fn write(&mut self, frame: &MediaFrame) {
        self.push(format!("write {} {}", frame.epoch, frame.flags & 1));
    }
    fn gap(&mut self) {
        self.push("gap".into());
    }
    fn cut(&mut self) {}
    fn meta(&mut self, _: u32, _: &serde_json::Value) {}
    fn finish(self: Box<Self>) -> Result<Vec<Part>, String> {
        self.push("finish".into());
        Ok(Vec::new())
    }
}

impl FakeRecorder {
    fn push(&self, line: String) {
        if let Ok(mut log) = self.0.lock() {
            log.push(line);
        }
    }
}

struct FakeRecorders(Log);

impl Recorders for FakeRecorders {
    fn start(&mut self, _: &RecordSpec<'_>) -> Result<Box<dyn Recorder>, String> {
        Ok(Box::new(FakeRecorder(self.0.clone())))
    }
}

fn written(log: &Log) -> Vec<String> {
    log.lock().map(|l| l.clone()).unwrap_or_default()
}

fn decide(
    engine: &mut Engine,
    seq: u64,
    decided: u32,
    clear: Value,
    discard: Value,
    now: Now,
) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "record.epochs", "source": "s1", "seq": seq, "decided": decided,
                "clear": clear, "discard": discard }),
        &[],
        now,
    )
}

#[test]
fn recorded_frames_reach_the_recorder_only_once_their_epoch_is_decided_clear() {
    let log = Log::default();
    let mut engine = Engine::new(Box::new(FakeRecorders(log.clone())));
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1_000_000, "pointerTrack": false }),
        &[],
        NOW,
    );
    hello(&mut engine, 1, 9);
    ingest(&mut engine, 1, unit(1, true), NOW);
    ingest(&mut engine, 1, unit(2, false), NOW);
    ingest(&mut engine, 1, unit(3, true), NOW);
    assert!(written(&log).is_empty(), "held until decided");

    // Decisions out of order: seq 1 waits for seq 0.
    assert!(decide(&mut engine, 1, 3, json!([[3, 3]]), json!([]), NOW).is_empty());
    let applied = decide(&mut engine, 0, 2, json!([[1, 1]]), json!([[2, 2]]), NOW);
    let answers: Vec<u64> = applied
        .iter()
        .filter_map(|e| match e {
            Effect::Priority(FromMedia::EpochsApplied { seq, .. }) => Some(seq.get()),
            _ => None,
        })
        .collect();
    assert_eq!(answers, [0, 1]);
    // Epoch 2 was discarded; the next part starts at epoch 3's keyframe.
    assert_eq!(written(&log), ["write 1 1", "write 3 1"]);

    let stopped = send(
        &mut engine,
        json!({ "type": "record.stop", "recording": "r1" }),
        &[],
        NOW,
    );
    assert!(matches!(
        stopped.as_slice(),
        [Effect::Normal(FromMedia::RecordDone { .. })]
    ));
}

#[test]
fn frames_held_past_the_bound_become_a_gap_and_never_reach_the_recorder() {
    let log = Log::default();
    let mut engine = Engine::new(Box::new(FakeRecorders(log.clone())));
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1_000_000, "pointerTrack": false }),
        &[],
        NOW,
    );
    hello(&mut engine, 1, 9);
    ingest(&mut engine, 1, unit(1, true), at(1_000));
    engine.tick(at(1_000 + media_core::privacy::HOLD_MS + 1));
    let ticked: Vec<Effect> = engine.effects().collect();
    assert!(ticked.iter().any(|e| matches!(
        e,
        Effect::Normal(FromMedia::SourceKeyframe { encode: 7, .. })
    )));
    decide(&mut engine, 0, 1, json!([[1, 1]]), json!([]), at(5_000));
    assert_eq!(written(&log), ["gap"]);
}

#[test]
fn without_a_recorder_recording_fails_and_decisions_are_still_answered() {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 9);
    let started = send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1, "pointerTrack": false }),
        &[],
        NOW,
    );
    assert!(matches!(
        started.as_slice(),
        [Effect::Normal(FromMedia::RecordFailed { reason, .. })] if reason == "recorder-unavailable"
    ));
    let answered = decide(&mut engine, 0, 1, json!([[1, 1]]), json!([]), NOW);
    assert!(matches!(
        answered.as_slice(),
        [Effect::Priority(FromMedia::EpochsApplied { .. })]
    ));
}

#[test]
fn work_this_binary_does_not_do_yet_fails_at_once_so_the_daemon_falls_back() {
    let mut engine = engine();
    let still = send(
        &mut engine,
        json!({ "type": "still.take", "request": "q", "source": "s1", "maxWidth": 10,
                "maxHeight": 10, "maxPixels": 100, "quality": 80, "deadlineMs": 500 }),
        &[],
        NOW,
    );
    assert!(matches!(
        still.as_slice(),
        [Effect::Normal(FromMedia::StillFailed { .. })]
    ));
    let dial = send(
        &mut engine,
        json!({ "type": "relay.dial", "stream": "st", "url": "wss://relay/join" }),
        &[],
        NOW,
    );
    assert!(matches!(
        dial.as_slice(),
        [Effect::Normal(FromMedia::RelayFailed { .. })]
    ));
}

#[test]
fn finishing_closes_every_connection_and_recording() {
    let log = Log::default();
    let mut engine = Engine::new(Box::new(FakeRecorders(log.clone())));
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "record.start", "recording": "r1", "source": "s1", "directory": "/tmp/r",
                "maxBytes": 1, "pointerTrack": false }),
        &[],
        NOW,
    );
    ticket(&mut engine, "c1", owner("d1", pairing(1)), 1, 1);
    engine.finish();
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(closed_connections(&effects), ["c1"]);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::Normal(FromMedia::RecordDone { .. })))
    );
    assert_eq!(written(&log), ["finish"]);
}
