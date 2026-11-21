// SPDX-License-Identifier: Apache-2.0
//! JPEG sources ace-media encodes itself (E4): what the engine tells their encoder threads.
use super::*;

fn open(engine: &mut Engine, kind: &str) {
    let origin = if kind == "screen-pictures" {
        json!({ "kind": kind, "platform": "windows" })
    } else {
        json!({ "kind": kind })
    };
    send(
        engine,
        json!({ "type": "source.open", "source": "p", "handle": 3, "epoch": 2,
                "origin": origin }),
        &[9; 32],
        NOW,
    );
    // Its producer connects to its ingest with the source's token, as the daemon's does.
    engine.ingest_hello(7, &[9; 32]);
    let _: Vec<Effect> = engine.effects().collect();
}

/// The JPEG every picture in these tests carries.
const JPEG: [u8; 4] = [0xff, 0xd8, 0xff, 0xd9];

fn encodes(engine: &mut Engine, list: Value) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "source.encodes", "source": "p", "encodes": list }),
        &[],
        NOW,
    )
}

fn spec() -> Value {
    json!([{ "id": 1, "codec": "avc1.42E01F", "width": 640, "height": 400, "fps": 30, "bitrate": 2_000_000 }])
}

/// One picture on the source's ingest, captured 5 ms before it was sent.
fn picture(engine: &mut Engine, epoch: u32, now: Now) -> Vec<Effect> {
    let mut picture = frame(3, 1, epoch, JPEG.to_vec());
    picture.codec = 7;
    picture.age_us = 5_000;
    ingest(engine, 7, picture, now)
}

fn encode_effects(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Encode(command) => Some(format!("{command:?}")),
            _ => None,
        })
        .collect()
}

#[test]
fn pictures_of_a_source_with_encodes_go_to_its_encoder_stamped_and_aged() {
    for kind in ["tab-pictures", "user-tab"] {
        let mut engine = engine();
        open(&mut engine, kind);
        assert_eq!(
            encode_effects(&encodes(&mut engine, spec())),
            ["Configure(p, 1 encodes)"]
        );
        let effects = picture(&mut engine, 2, at(2_000));
        assert_eq!(encode_effects(&effects), ["Picture(p, epoch 2)"]);
        let aged = effects.iter().any(|e| {
            matches!(e, Effect::Encode(EncodeEffect::Picture { age_us: 5_000, jpeg, .. }) if jpeg == &JPEG)
        });
        assert!(aged, "the JPEG as received, with its age");
        assert!(statuses(&effects).is_empty(), "playing waits for a unit");
    }
}

#[test]
fn a_picture_newer_than_a_private_epoch_keeps_the_private_one_within_the_read_gap() {
    let mut engine = engine();
    open(&mut engine, "tab-pictures");
    encodes(&mut engine, spec());
    send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "p", "seq": 1, "epoch": 3, "followsPrivate": true }),
        &[],
        at(2_000),
    );
    let early = picture(&mut engine, 3, at(2_050));
    let late = picture(&mut engine, 3, at(2_200));
    assert_eq!(encode_effects(&early), ["Picture(p, epoch 2)"]);
    assert_eq!(encode_effects(&late), ["Picture(p, epoch 3)"]);
}

#[test]
fn a_picture_captured_before_a_privacy_change_and_delivered_after_never_reaches_encoder_or_egress()
{
    // Egress carries a source's units to the daemon's recording and to every viewer.
    let lane = Kept::default();
    let mut engine = Engine::new(
        Box::new(super::super::recorder::NoRecorders),
        Box::new(lane.clone()),
    );
    open(&mut engine, "tab-pictures");
    send(
        &mut engine,
        json!({ "type": "source.egress", "source": "p", "on": true }),
        &[],
        NOW,
    );
    // Not encoding yet: pictures go to egress as they are. Then the tab changes privacy
    // (epoch 4) and a picture captured before it (epoch 3) arrives late.
    picture(&mut engine, 4, at(2_000));
    picture(&mut engine, 3, at(2_010));
    assert_eq!(lane.order(), ["unit"], "only the epoch-4 picture went on");
    // Encoding now: the late one never reaches the encoder either.
    encodes(&mut engine, spec());
    assert!(encode_effects(&picture(&mut engine, 3, at(2_020))).is_empty());
    assert_eq!(
        encode_effects(&picture(&mut engine, 4, at(2_030))),
        ["Picture(p, epoch 4)"]
    );
}

#[test]
fn an_older_daemons_picture_on_the_control_lane_ends_its_source_saying_why_once() {
    let mut engine = engine();
    open(&mut engine, "tab-pictures");
    let _: Vec<Effect> = engine.effects().collect();
    engine.skipped("source.picture", Some("p"));
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(
        statuses(&effects),
        [(
            "p".to_owned(),
            Status::Ended,
            Some("picture-ingest-required".to_owned())
        )]
    );
    // Said once; one naming no source, or a source that isn't a JPEG source, says nothing.
    engine.skipped("source.picture", Some("p"));
    engine.skipped("source.picture", None);
    engine.skipped("source.someday", Some("p"));
    assert!(statuses(&engine.effects().collect::<Vec<_>>()).is_empty());
    let mut tab = super::engine();
    open_tab(&mut tab, "t", 4, 8);
    let _: Vec<Effect> = tab.effects().collect();
    tab.skipped("source.picture", Some("t"));
    assert!(statuses(&tab.effects().collect::<Vec<_>>()).is_empty());
}

#[test]
fn opened_private_then_public_then_private_again_never_stamps_a_new_private_picture_public() {
    let lane = Kept::default();
    let mut engine = Engine::new(
        Box::new(super::super::recorder::NoRecorders),
        Box::new(lane.clone()),
    );
    send(
        &mut engine,
        json!({ "type": "source.open", "source": "p", "handle": 3, "epoch": 1, "private": true,
                "origin": { "kind": "tab-pictures" } }),
        &[9; 32],
        NOW,
    );
    engine.ingest_hello(7, &[9; 32]);
    encodes(&mut engine, spec());
    let epoch = |engine: &mut Engine, seq: u64, epoch: u32, follows: bool, now: Now| {
        send(
            engine,
            json!({ "type": "source.epoch", "source": "p", "seq": seq, "epoch": epoch,
                    "followsPrivate": follows }),
            &[],
            now,
        )
    };
    // Private 1 (the open) → public 2 → private 3.
    epoch(&mut engine, 1, 2, true, at(2_000));
    epoch(&mut engine, 2, 3, false, at(3_000));
    // An epoch-3 picture read 50 ms after private 3 began keeps epoch 3: the read gap after
    // a public epoch holds nothing.
    let effects = picture(&mut engine, 3, at(3_050));
    assert_eq!(encode_effects(&effects), ["Picture(p, epoch 3)"]);
}

#[test]
fn a_tab_source_takes_no_encodes_and_a_closed_source_stops_its_encoder() {
    let mut tab = engine();
    open_tab(&mut tab, "p", 3, 9);
    assert!(encode_effects(&encodes(&mut tab, spec())).is_empty());

    let mut engine = super::engine();
    open(&mut engine, "tab-pictures");
    encodes(&mut engine, spec());
    let closed = send(
        &mut engine,
        json!({ "type": "source.close", "source": "p" }),
        &[],
        NOW,
    );
    // It drains first; its thread ends once the encoder has handed over its last output.
    assert_eq!(encode_effects(&closed), ["Drain(p)"]);
    engine.encoder_drained("p", 1);
    let drained: Vec<Effect> = engine.effects().collect();
    assert_eq!(encode_effects(&drained), ["Close(p)"]);
}

#[test]
fn encoded_units_play_the_source_and_its_steps_ride_its_status() {
    let mut engine = engine();
    open(&mut engine, "tab-pictures");
    encodes(&mut engine, spec());
    engine.encoded("p", 1, unit(2, true), NOW);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(statuses(&effects), [("p".into(), Status::Playing, None)]);
    let acceleration = media_wire::capability::Acceleration {
        steps: Vec::new(),
        degraded: false,
        reason: None,
    };
    engine.encoder_steps("p", 1, acceleration);
    let effects: Vec<Effect> = engine.effects().collect();
    let carried = effects.iter().any(|e| {
        matches!(
            e,
            Effect::Normal(FromMedia::SourceStatus {
                status: Status::Playing,
                acceleration: Some(_),
                ..
            })
        )
    });
    assert!(carried);
}

#[test]
fn a_failed_encoder_ends_the_source_so_the_daemon_takes_it_back() {
    let mut engine = engine();
    open(&mut engine, "user-tab");
    encodes(&mut engine, spec());
    engine.encoder_failed("p", 1, "encoder-unavailable");
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(
        statuses(&effects),
        [(
            "p".into(),
            Status::Ended,
            Some("encoder-unavailable".into())
        )]
    );
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    // Later pictures and units change nothing.
    assert!(encode_effects(&picture(&mut engine, 2, NOW)).is_empty());
    engine.encoded("p", 1, unit(2, true), NOW);
    assert_eq!(engine.effects().count(), 0);
}

/// An egress lane that keeps every frame it is given.
#[derive(Clone, Default)]
struct Kept(std::sync::Arc<std::sync::Mutex<Vec<media_wire::frame::Egress>>>);

impl super::super::egress::EgressSink for Kept {
    fn offer(&mut self, frame: Vec<u8>) -> bool {
        self.force(frame);
        true
    }
    fn force(&mut self, frame: Vec<u8>) {
        if let (Ok(e), Ok(mut kept)) = (media_wire::frame::Egress::decode(&frame), self.0.lock()) {
            kept.push(e);
        }
    }
}

impl Kept {
    /// `"unit"` or `"end"`/`"cut"` for each frame, in order.
    fn order(&self) -> Vec<&'static str> {
        self.0
            .lock()
            .map(|k| {
                k.iter()
                    .map(|e| match e.frame.end() {
                        Some(end) if end.interrupted => "cut",
                        Some(_) => "end",
                        None => "unit",
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// An encoding picture source with egress on, on an engine whose lane keeps everything.
fn encoding() -> (Engine, Kept) {
    let lane = Kept::default();
    let mut engine = Engine::new(
        Box::new(super::super::recorder::NoRecorders),
        Box::new(lane.clone()),
    );
    open(&mut engine, "tab-pictures");
    send(
        &mut engine,
        json!({ "type": "source.egress", "source": "p", "on": true }),
        &[],
        NOW,
    );
    encodes(&mut engine, spec());
    (engine, lane)
}

fn close(engine: &mut Engine, now: Now) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "source.close", "source": "p" }),
        &[],
        now,
    )
}

#[test]
fn closing_an_encoding_source_waits_for_its_encoder_to_drain_before_a_clean_end() {
    let (mut engine, lane) = encoding();
    engine.encoded("p", 1, unit(2, true), NOW);
    let _ = engine.effects().count();
    let closed = close(&mut engine, NOW);
    assert_eq!(encode_effects(&closed), ["Drain(p)"]);
    assert_eq!(
        lane.order(),
        ["unit"],
        "no marker while output may be pending"
    );
    // Output the encoder still had, after the close: it is delivered, not thrown away.
    engine.encoded("p", 1, unit(2, false), NOW);
    engine.encoded("p", 1, unit(2, false), NOW);
    engine.encoder_drained("p", 1);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    assert_eq!(lane.order(), ["unit", "unit", "unit", "end"]);
    // Nothing after the end.
    engine.encoded("p", 1, unit(2, false), NOW);
    assert_eq!(lane.order().len(), 4);
}

#[test]
fn a_picture_sources_ingest_end_drains_its_encoder_and_the_clean_marker_follows_its_last_unit() {
    let (mut engine, lane) = encoding();
    // The producer's last picture is in, and its ingest ends gracefully.
    let effects = ingest(&mut engine, 7, frame(4, 0, 0, Vec::new()), NOW);
    assert_eq!(encode_effects(&effects), ["Drain(p)"]);
    // What the encoder still held comes out after: delivered, not thrown away.
    engine.encoded("p", 1, unit(2, true), NOW);
    engine.encoded("p", 1, unit(2, false), NOW);
    assert_eq!(
        lane.order(),
        ["unit", "unit"],
        "no marker while output may be pending"
    );
    engine.encoder_drained("p", 1);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    assert_eq!(lane.order(), ["unit", "unit", "end"]);
    // The daemon's close after the marker changes nothing.
    close(&mut engine, NOW);
    assert_eq!(lane.order(), ["unit", "unit", "end"]);
}

#[test]
fn an_encoder_that_cannot_drain_ends_its_source_interrupted() {
    let (mut engine, lane) = encoding();
    close(&mut engine, NOW);
    engine.encoder_failed("p", 1, "encoder-undrainable");
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    assert_eq!(lane.order(), ["cut"]);
}

#[test]
fn a_drain_that_never_finishes_ends_interrupted_at_its_deadline() {
    let (mut engine, lane) = encoding();
    close(&mut engine, at(1_000));
    engine.tick(at(1_000 + super::super::sources::DRAIN_MS - 1));
    assert!(lane.order().is_empty());
    engine.tick(at(1_000 + super::super::sources::DRAIN_MS));
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    assert_eq!(lane.order(), ["cut"]);
    engine.encoder_drained("p", 1);
    assert_eq!(lane.order(), ["cut"]);
}

/// The encoder token a `Configure` effect carries.
fn token_of(effects: &[Effect]) -> u64 {
    effects
        .iter()
        .find_map(|e| match e {
            Effect::Encode(EncodeEffect::Configure { token, .. }) => Some(*token),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no Configure in {effects:?}"))
}

/// `(handle, "unit" | "end" | "cut")` for each frame the lane kept.
fn by_handle(lane: &Kept) -> Vec<(u32, &'static str)> {
    lane.0
        .lock()
        .map(|k| {
            k.iter()
                .map(|e| {
                    let what = match e.frame.end() {
                        Some(end) if end.interrupted => "cut",
                        Some(_) => "end",
                        None => "unit",
                    };
                    (e.handle, what)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Reopens `p` under handle 4 with egress and encodes; the new encoder's token.
fn reopen(engine: &mut Engine) -> u64 {
    send(
        engine,
        json!({ "type": "source.open", "source": "p", "handle": 4, "epoch": 2,
                "origin": { "kind": "tab-pictures" } }),
        &[8; 32],
        NOW,
    );
    send(
        engine,
        json!({ "type": "source.egress", "source": "p", "on": true }),
        &[],
        NOW,
    );
    token_of(&encodes(engine, spec()))
}

#[test]
fn units_the_old_encoder_still_had_queued_never_reach_a_source_reopened_under_its_id() {
    let (mut engine, lane) = encoding();
    let old = 1;
    engine.encoded("p", old, unit(2, true), NOW);
    let new = reopen(&mut engine);
    assert_ne!(old, new);
    engine.encoded("p", old, unit(2, false), NOW);
    engine.encoder_steps(
        "p",
        old,
        media_wire::capability::Acceleration {
            steps: Vec::new(),
            degraded: true,
            reason: None,
        },
    );
    let _ = engine.effects().count();
    assert!(by_handle(&lane).iter().all(|(handle, _)| *handle == 3));
    engine.encoded("p", new, unit(2, true), NOW);
    assert_eq!(by_handle(&lane).last(), Some(&(4, "unit")));
}

#[test]
fn an_old_encoders_drained_after_the_reopened_source_closes_ends_nothing() {
    let (mut engine, lane) = encoding();
    let old = 1;
    close(&mut engine, NOW);
    let new = reopen(&mut engine);
    let closed = close(&mut engine, NOW);
    assert_eq!(encode_effects(&closed), ["Drain(p)"]);
    engine.encoder_drained("p", old);
    engine.encoder_failed("p", old, "encoder-undrainable");
    let stale: Vec<Effect> = engine.effects().collect();
    assert!(encode_effects(&stale).is_empty(), "{stale:?}");
    assert!(!by_handle(&lane).iter().any(|(handle, _)| *handle == 4));
    engine.encoder_drained("p", new);
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(encode_effects(&effects), ["Close(p)"]);
    assert_eq!(by_handle(&lane).last(), Some(&(4, "end")));
}

#[test]
fn stuck_encoder_threads_count_against_the_limits_and_two_make_ace_media_restart() {
    let mut engine = engine();
    engine.encoders_stuck(1);
    let _ = engine.effects().count();
    // One encoder slot is held by the stuck thread.
    for n in 0..super::super::sources::MAX_ENCODERS - 1 {
        let id = format!("e{n}");
        send(
            &mut engine,
            json!({ "type": "source.open", "source": id, "handle": 100 + n, "epoch": 0,
                    "origin": { "kind": "tab-pictures" } }),
            &[n as u8; 32],
            NOW,
        );
        let effects = send(
            &mut engine,
            json!({ "type": "source.encodes", "source": id, "encodes": spec() }),
            &[],
            NOW,
        );
        assert_eq!(encode_effects(&effects).len(), 1, "encoder {n}");
    }
    send(
        &mut engine,
        json!({ "type": "source.open", "source": "last", "handle": 999, "epoch": 0,
                "origin": { "kind": "tab-pictures" } }),
        &[250; 32],
        NOW,
    );
    let refused = send(
        &mut engine,
        json!({ "type": "source.encodes", "source": "last", "encodes": spec() }),
        &[],
        NOW,
    );
    assert!(encode_effects(&refused).is_empty());
    assert_eq!(
        statuses(&refused),
        [("last".into(), Status::Ended, Some("encoder-limit".into()))]
    );
    // A second stuck thread: ace-media exits so the supervisor restarts it and the OS frees
    // what the threads hold.
    engine.encoders_stuck(2);
    let effects: Vec<Effect> = engine.effects().collect();
    assert!(effects.iter().any(|e| matches!(e, Effect::Fatal(_))));
}

#[test]
fn stuck_encoder_threads_count_against_the_source_limit() {
    let mut engine = engine();
    engine.encoders_stuck(1);
    let _ = engine.effects().count();
    for n in 0..super::super::sources::MAX_SOURCES - 1 {
        let effects = send(
            &mut engine,
            json!({ "type": "source.open", "source": format!("s{n}"), "handle": n + 1, "epoch": 0,
                    "origin": { "kind": "tab" } }),
            &[(n % 250) as u8; 32],
            NOW,
        );
        assert_eq!(statuses(&effects)[0].1, Status::Starting, "source {n}");
    }
    let refused = send(
        &mut engine,
        json!({ "type": "source.open", "source": "over", "handle": 9999, "epoch": 0,
                "origin": { "kind": "tab" } }),
        &[251; 32],
        NOW,
    );
    assert_eq!(statuses(&refused)[0].2.as_deref(), Some("source-limit"));
}

#[test]
fn a_jpeg_on_a_picture_sources_ingest_lane_goes_to_its_encoder_as_it_is() {
    let mut engine = engine();
    open(&mut engine, "screen-pictures");
    encodes(&mut engine, spec());
    let effects = picture(&mut engine, 2, at(2_000));
    let given = effects
        .iter()
        .any(|e| matches!(e, Effect::Encode(EncodeEffect::Picture { jpeg, .. }) if jpeg == &JPEG));
    assert!(
        given,
        "the JPEG bytes themselves: {:?}",
        encode_effects(&effects)
    );
}
