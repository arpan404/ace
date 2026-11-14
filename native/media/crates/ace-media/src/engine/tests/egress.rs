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

    /// End markers are queued whatever the room.
    fn force(&mut self, frame: Vec<u8>) {
        let Ok(decoded) = Egress::decode(&frame) else {
            panic!("the engine wrote an invalid egress frame");
        };
        if let Ok(mut frames) = self.frames.lock() {
            frames.push(decoded);
        }
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
    // Its last unit, then the end marker the close sent, then nothing.
    let frames = lane.drain();
    assert_eq!(sent(&frames[..1]), [(5, 0, 1)]);
    assert_eq!(ends(&frames[1..]), [(5, 1, false)]);
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

/// `(handle, sequence, interrupted)` of each end marker sent, in order.
fn ends(frames: &[Egress]) -> Vec<(u32, u32, bool)> {
    frames
        .iter()
        .filter_map(|e| {
            e.frame
                .end()
                .map(|end| (e.handle, e.sequence, end.interrupted))
        })
        .collect()
}

#[test]
fn a_producer_that_ends_cleanly_gets_an_end_marker_after_its_last_unit_even_on_a_full_lane() {
    let lane = Lane::new(2);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "a", 11, 1);
    egress(&mut engine, "a", true);
    for key in [true, false, false] {
        ingest(&mut engine, 1, unit(1, key), NOW);
    }
    // The lane took two units and is full; the end still goes, after them.
    ingest(&mut engine, 1, frame(4, 0, 0, Vec::new()), NOW);
    let frames = lane.drain();
    assert_eq!(frames.len(), 3);
    assert_eq!(ends(&frames), [(11, 3, false)]);
    assert!(frames.last().is_some_and(|f| f.frame.end().is_some()));
    // Closing the ended source sends no second marker.
    send(
        &mut engine,
        json!({ "type": "source.close", "source": "a" }),
        &[],
        NOW,
    );
    assert!(lane.drain().is_empty());
}

#[test]
fn a_producer_connection_that_drops_gets_an_interrupted_end_marker() {
    let lane = Lane::new(16);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "a", 11, 1);
    egress(&mut engine, "a", true);
    ingest(&mut engine, 1, unit(1, true), NOW);
    engine.ingest_closed(1, NOW);
    let _ = engine.effects().count();
    assert_eq!(ends(&lane.drain()), [(11, 1, true)]);
}

#[test]
fn closing_a_source_whose_producer_still_streams_ends_it_with_a_marker() {
    let lane = Lane::new(16);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "a", 11, 1);
    egress(&mut engine, "a", true);
    ingest(&mut engine, 1, unit(1, true), NOW);
    send(
        &mut engine,
        json!({ "type": "source.close", "source": "a" }),
        &[],
        NOW,
    );
    assert_eq!(ends(&lane.drain()), [(11, 1, false)]);
}

#[test]
fn a_source_without_egress_sends_no_marker() {
    let lane = Lane::new(16);
    let mut engine = with_lane(&lane);
    streaming(&mut engine, "a", 11, 1);
    ingest(&mut engine, 1, unit(1, true), NOW);
    ingest(&mut engine, 1, frame(4, 0, 0, Vec::new()), NOW);
    assert!(lane.drain().is_empty());
}

#[test]
fn a_simulator_is_read_by_ace_media_its_units_stamped_with_the_source_epoch_and_its_close_ends_cleanly()
 {
    let lane = Lane::new(64);
    let mut engine = with_lane(&lane);
    let opened = send(
        &mut engine,
        json!({ "type": "source.open", "source": "sim", "handle": 4, "epoch": 6,
                "origin": { "kind": "simulator",
                            "streamUrl": "http://127.0.0.1:3100/stream.avcc",
                            "stillUrl": "http://127.0.0.1:3100/frame.jpeg" } }),
        &[2; 32],
        NOW,
    );
    assert_eq!(statuses(&opened), [("sim".into(), Status::Starting, None)]);
    let found = opened.iter().find_map(|e| match e {
        Effect::Encode(EncodeEffect::Read { source, token, url }) => {
            assert_eq!(
                (source.as_str(), url.as_str()),
                ("sim", "http://127.0.0.1:3100/stream.avcc")
            );
            Some(*token)
        }
        _ => None,
    });
    let Some(token) = found else {
        panic!("the reader starts with the source");
    };
    egress(&mut engine, "sim", true);
    // What the reader read carries no epoch of its own: the source's is stamped on it.
    engine.encoded("sim", token, frame(1, 1, 0, vec![7; 10]), NOW);
    let units = lane.drain();
    assert_eq!(sent(&units), [(4, 0, 7)]);
    assert_eq!(units[0].frame.epoch, 6);
    // A keyframe request reaches the reader.
    let keyed = send(
        &mut engine,
        json!({ "type": "source.key", "source": "sim", "encode": 0 }),
        &[],
        NOW,
    );
    assert!(
        keyed.iter().any(
            |e| matches!(e, Effect::Encode(EncodeEffect::Key { token: t, .. }) if *t == token)
        )
    );
    // Closing drains the reader, then the source's end marker follows its last unit.
    let closing = send(
        &mut engine,
        json!({ "type": "source.close", "source": "sim" }),
        &[],
        NOW,
    );
    assert!(
        closing
            .iter()
            .any(|e| matches!(e, Effect::Encode(EncodeEffect::Drain { .. })))
    );
    engine.encoder_drained("sim", token);
    let ended = lane.drain();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].frame.kind, 4, "the end marker");
    assert_eq!(ended[0].frame.flags & 8, 0, "a clean end");
}

#[test]
fn a_simulators_encodes_go_to_its_reader_which_re_encodes_for_the_viewer() {
    let lane = Lane::new(64);
    let mut engine = with_lane(&lane);
    let opened = send(
        &mut engine,
        json!({ "type": "source.open", "source": "sim", "handle": 4, "epoch": 1,
                "origin": { "kind": "simulator",
                            "streamUrl": "http://127.0.0.1:3100/stream.avcc",
                            "stillUrl": "http://127.0.0.1:3100/frame.jpeg" } }),
        &[2; 32],
        NOW,
    );
    let reader = opened.iter().find_map(|e| match e {
        Effect::Encode(EncodeEffect::Read { token, .. }) => Some(*token),
        _ => None,
    });
    let encodes = json!([{ "id": 1, "codec": "avc1.640033", "width": 588, "height": 1280,
                           "fps": 60, "bitrate": 6000000 }]);
    let configured = send(
        &mut engine,
        json!({ "type": "source.encodes", "source": "sim", "encodes": encodes }),
        &[],
        NOW,
    );
    let sent = configured.iter().find_map(|e| match e {
        Effect::Encode(EncodeEffect::Configure { token, encodes, .. }) => {
            Some((*token, encodes.len()))
        }
        _ => None,
    });
    assert_eq!(sent, reader.map(|token| (token, 1)), "the reader's own token, no new encoder");
    assert_eq!(statuses(&configured), []);
}
