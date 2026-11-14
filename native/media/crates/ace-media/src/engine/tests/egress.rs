// SPDX-License-Identifier: Apache-2.0
//! The egress writer: which units go back to the daemon, under which handle and sequence, and
//! what a full egress does.
use super::super::egress::EgressSink;
use super::super::recorder::NoRecorders;
use super::super::*;
use super::*;
use media_wire::control::{FromMedia, KeyReason};
use media_wire::frame::Egress;
use serde_json::json;
use std::sync::{Arc, Mutex};

/// A lane that holds `room` frames; the test drains it.
#[derive(Clone)]
struct Lane {
    frames: Arc<Mutex<Vec<Egress>>>,
    room: Arc<Mutex<usize>>,
}

impl Lane {
    fn new(room: usize) -> Self {
        Self {
            frames: Arc::default(),
            room: Arc::new(Mutex::new(room)),
        }
    }

    fn drain(&self) -> Vec<Egress> {
        self.frames
            .lock()
            .map(|mut f| std::mem::take(&mut *f))
            .unwrap_or_default()
    }

    fn set_room(&self, room: usize) {
        if let Ok(mut r) = self.room.lock() {
            *r = room;
        }
    }
}

impl EgressSink for Lane {
    fn offer(&mut self, frame: Vec<u8>) -> bool {
        let Ok(mut room) = self.room.lock() else {
            return false;
        };
        if *room == 0 {
            return false;
        }
        *room -= 1;
        let Ok(decoded) = Egress::decode(&frame) else {
            panic!("the engine wrote an invalid egress frame");
        };
        if let Ok(mut frames) = self.frames.lock() {
            frames.push(decoded);
        }
        true
    }
}

fn with_lane(lane: &Lane) -> Engine {
    Engine::new(Box::new(NoRecorders), Box::new(lane.clone()))
}

fn egress(engine: &mut Engine, source: &str, on: bool) {
    send(
        engine,
        json!({ "type": "source.egress", "source": source, "on": on }),
        &[],
        NOW,
    );
}

/// Opens a tab source and admits its producer on connection `conn`.
fn streaming(engine: &mut Engine, source: &str, handle: u32, conn: u64) {
    open_tab(engine, source, handle, conn as u8);
    hello(engine, conn, conn as u8);
}

fn sent(frames: &[Egress]) -> Vec<(u32, u32, u8)> {
    frames
        .iter()
        .map(|e| (e.handle, e.sequence, e.frame.payload[0]))
        .collect()
}

fn marked(key: bool, mark: u8) -> media_wire::frame::MediaFrame {
    frame(1, u32::from(key), 1, vec![mark; 10])
}

fn keyframe_requests(effects: &[Effect]) -> Vec<(String, u32, KeyReason)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::SourceKeyframe {
                source,
                encode,
                reason,
            }) => Some((source.get().to_owned(), *encode, reason.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn egress_stays_idle_until_the_daemon_turns_it_on_for_a_source() {
    let lane = Lane::new(100);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 40, 1);
    ingest(&mut engine, 1, marked(true, 1), NOW);
    assert!(lane.drain().is_empty(), "off by default");

    egress(&mut engine, "s1", true);
    ingest(&mut engine, 1, marked(true, 2), NOW);
    ingest(&mut engine, 1, marked(false, 3), NOW);
    assert_eq!(sent(&lane.drain()), [(40, 0, 2), (40, 1, 3)]);

    egress(&mut engine, "s1", false);
    ingest(&mut engine, 1, marked(true, 4), NOW);
    assert!(lane.drain().is_empty(), "off again");
}

#[test]
fn two_sources_with_the_same_encode_id_go_out_under_their_own_handles_and_sequences() {
    let lane = Lane::new(100);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "a", 10, 1);
    streaming(&mut engine, "b", 20, 2);
    egress(&mut engine, "a", true);
    egress(&mut engine, "b", true);
    // Both producers use encode id 7; their units interleave.
    for (conn, mark, key) in [
        (1, 1, true),
        (2, 2, true),
        (1, 3, false),
        (2, 4, false),
        (2, 5, false),
    ] {
        ingest(&mut engine, conn, marked(key, mark), NOW);
    }
    assert_eq!(
        sent(&lane.drain()),
        [(10, 0, 1), (20, 0, 2), (10, 1, 3), (20, 1, 4), (20, 2, 5)]
    );
}

#[test]
fn a_closed_source_sends_nothing_more_on_egress() {
    let lane = Lane::new(100);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 5, 1);
    egress(&mut engine, "s1", true);
    ingest(&mut engine, 1, marked(true, 1), NOW);
    send(
        &mut engine,
        json!({ "type": "source.close", "source": "s1" }),
        &[],
        NOW,
    );
    ingest(&mut engine, 1, marked(true, 2), NOW);
    assert_eq!(sent(&lane.drain()), [(5, 0, 1)]);
}

#[test]
fn a_full_egress_drops_deltas_to_the_next_keyframe_asks_for_one_once_and_leaves_a_sequence_gap() {
    let lane = Lane::new(1);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 3, 1);
    egress(&mut engine, "s1", true);
    assert!(keyframe_requests(&ingest(&mut engine, 1, marked(true, 1), NOW)).is_empty());

    // The lane is full: this delta is dropped and a keyframe asked for, once.
    let full = ingest(&mut engine, 1, marked(false, 2), NOW);
    assert_eq!(
        keyframe_requests(&full),
        [("s1".into(), 7, KeyReason::Drop)]
    );
    lane.set_room(100);
    // Room again, but deltas still wait for the keyframe, and nothing more is asked.
    assert!(keyframe_requests(&ingest(&mut engine, 1, marked(false, 3), NOW)).is_empty());
    ingest(&mut engine, 1, marked(true, 4), NOW);
    ingest(&mut engine, 1, marked(false, 5), NOW);
    assert_eq!(sent(&lane.drain()), [(3, 0, 1), (3, 3, 4), (3, 4, 5)]);
}

#[test]
fn egress_turned_on_mid_stream_starts_at_a_keyframe() {
    let lane = Lane::new(100);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 3, 1);
    ingest(&mut engine, 1, marked(true, 1), NOW);
    egress(&mut engine, "s1", true);
    let delta = ingest(&mut engine, 1, marked(false, 2), NOW);
    assert_eq!(
        keyframe_requests(&delta),
        [("s1".into(), 7, KeyReason::Resume)]
    );
    ingest(&mut engine, 1, marked(true, 3), NOW);
    assert_eq!(sent(&lane.drain()), [(3, 1, 3)]);
}

#[test]
fn audio_and_pictures_go_out_without_waiting_for_a_keyframe() {
    let lane = Lane::new(100);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 9, 1);
    egress(&mut engine, "s1", true);
    let mut audio = frame(2, 0, 1, vec![1; 4]);
    audio.codec = 9;
    ingest(&mut engine, 1, audio, NOW);
    let mut picture = frame(3, 0, 1, vec![2; 4]);
    picture.codec = 7;
    ingest(&mut engine, 1, picture, NOW);
    assert_eq!(sent(&lane.drain()), [(9, 0, 1), (9, 1, 2)]);
}

#[test]
fn a_picture_never_reopens_a_video_gate_closed_by_a_full_egress() {
    let lane = Lane::new(1);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 4, 1);
    egress(&mut engine, "s1", true);
    ingest(&mut engine, 1, marked(true, 1), NOW);
    // Full: the delta closes encode 7's gate.
    ingest(&mut engine, 1, marked(false, 2), NOW);
    lane.set_room(100);
    // A picture under the same encode id goes out, and deltas still wait for a keyframe.
    let mut picture = frame(3, 0, 1, vec![3; 4]);
    picture.codec = 7;
    ingest(&mut engine, 1, picture, NOW);
    ingest(&mut engine, 1, marked(false, 4), NOW);
    ingest(&mut engine, 1, marked(true, 5), NOW);
    assert_eq!(sent(&lane.drain()), [(4, 0, 1), (4, 2, 3), (4, 4, 5)]);
}

#[test]
fn an_encode_past_the_gate_bound_is_logged_and_its_successor_starts_at_a_keyframe() {
    let lane = Lane::new(1000);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "s1", 6, 1);
    egress(&mut engine, "s1", true);
    let mut logged = Vec::new();
    for encode in 0..17u32 {
        let mut unit = marked(true, encode as u8);
        unit.encode = encode;
        logged.extend(ingest(&mut engine, 1, unit, NOW));
    }
    let warnings = logged
        .iter()
        .filter(|e| matches!(e, Effect::Normal(FromMedia::Log { message, .. }) if message.contains("gate")))
        .count();
    assert_eq!(warnings, 1);
    // Encode 0 was forgotten: its next delta waits for a keyframe again.
    let mut delta = marked(false, 99);
    delta.encode = 0;
    let effects = ingest(&mut engine, 1, delta, NOW);
    assert_eq!(
        keyframe_requests(&effects),
        [("s1".into(), 0, KeyReason::Resume)]
    );
    assert_eq!(lane.drain().len(), 17);
}
