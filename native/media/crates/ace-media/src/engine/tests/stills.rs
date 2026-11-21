// SPDX-License-Identifier: Apache-2.0
//! `still.take` end to end through the engine, against a model decoder standing in for the
//! hardware. Each length-prefixed test unit's payload is `[picture id, encode id]`, and its
//! configuration record names its codec and width. Annex B units are real NAL units: parameter
//! sets and slices tagged with the stream they belong to, whose record the model builds with
//! `record::video` as the real maker does. The model decodes as a real decoder does: a group starts at a
//! keyframe whose record fits it, a decoder fed another stream's units or a stale record
//! fails, and a still is the last picture decoded. So every assertion is on what the daemon
//! receives: the still's picture and size, or why it failed.
use super::super::stills::{
    DECODE_FAILED, Made, NEEDS_KEYFRAME, StillInput, StillJob, StillMaker, StillOutcome, StillUnit,
};
use super::*;
use media_codec::Size;
use media_wire::control::KeyReason;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct Stream {
    group: u64,
    /// The encode of the group's keyframe: the only stream this decoder can continue.
    encode: u8,
    decoded_at: Size,
    picture: Option<u8>,
}

#[derive(Default)]
struct Model {
    streams: HashMap<u32, Stream>,
    /// Finished jobs, delivered when the test lets them arrive.
    outcomes: Vec<StillOutcome>,
    full: bool,
}

#[derive(Clone, Default)]
struct Maker(Arc<Mutex<Model>>);

impl Maker {
    fn model(&self) -> std::sync::MutexGuard<'_, Model> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The record a length-prefixed unit of `codec` at `width` needs. Annex B (1 and 3) carries
/// its parameter sets in band, so it decodes without one, but not with another stream's.
fn record(codec: u8, width: u16) -> Vec<u8> {
    vec![codec, (width / 10) as u8]
}

/// A unit's picture id and the stream it was coded in.
fn coded(unit: &StillUnit) -> (u8, u8) {
    if unit.codec != 1 {
        return (unit.payload[0], unit.payload[1]);
    }
    let nals = crate::record::video::nal_units(&unit.payload);
    match nals.iter().find(|n| matches!(n[0] & 0x1f, 1 | 5)) {
        Some(slice) => (slice[2], slice[1]),
        None => (0, 0),
    }
}

/// Whether a keyframe's record is the one its stream was coded with.
fn fits(key: &StillUnit) -> bool {
    if key.codec == 3 && key.description.is_empty() {
        // The length-prefixed tests' stand-in for parameter sets in band.
        return true;
    }
    if key.codec != 1 {
        return key.description == record(key.codec, key.size.width as u16);
    }
    let Ok(made) = crate::record::video::encoded(1, &key.payload, &key.description) else {
        return false;
    };
    let stream = coded(key).1;
    made.description
        .is_some_and(|r| r.windows(2).any(|w| w == [0x68, stream]))
}

fn decode(streams: &mut HashMap<u32, Stream>, job: &StillJob) -> Result<u8, String> {
    let StillInput::Video { group, units, .. } = &job.input else {
        unreachable!()
    };
    if streams.get(&job.stream).is_none_or(|s| s.group != *group) {
        let Some(key) = units.first().filter(|u| u.key) else {
            return Err(NEEDS_KEYFRAME.into());
        };
        if !fits(key) {
            return Err(DECODE_FAILED.into());
        }
        let stream = Stream {
            group: *group,
            encode: coded(key).1,
            decoded_at: job.target,
            picture: None,
        };
        streams.insert(job.stream, stream);
    }
    let Some(state) = streams.get_mut(&job.stream) else {
        unreachable!()
    };
    for unit in units {
        let (picture, stream) = coded(unit);
        if stream != state.encode {
            return Err(DECODE_FAILED.into());
        }
        state.picture = Some(picture);
    }
    if job.target.width > state.decoded_at.width {
        return Err(NEEDS_KEYFRAME.into());
    }
    state.picture.ok_or_else(|| "no-picture".into())
}

impl StillMaker for Maker {
    fn take(&mut self, job: StillJob) -> Result<(), StillJob> {
        let mut model = self.model();
        if model.full {
            return Err(job);
        }
        let result = match &job.input {
            StillInput::Jpeg { data, .. } => Ok(data.to_vec()),
            StillInput::Video { .. } => decode(&mut model.streams, &job).map(|p| vec![p]),
        };
        let outcome = StillOutcome {
            request: job.request,
            token: job.token,
            result: result.map(|jpeg| Made {
                jpeg,
                size: job.target,
                steps: Vec::new(),
            }),
        };
        model.outcomes.push(outcome);
        Ok(())
    }
    fn forget(&mut self, stream: u32) {
        self.model().streams.remove(&stream);
    }
}

fn with_maker() -> (Engine, Maker) {
    let maker = Maker::default();
    (engine().with_stills(Box::new(maker.clone())), maker)
}

/// How a request ended, as the daemon sees it.
#[derive(Debug, PartialEq)]
enum Answer {
    Still {
        request: String,
        picture: Vec<u8>,
        size: (u32, u32),
    },
    Failed {
        request: String,
        reason: String,
    },
}

fn answers(effects: &[Effect]) -> Vec<Answer> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::NormalWith(
                FromMedia::StillDone {
                    request,
                    width,
                    height,
                    ..
                },
                jpeg,
            ) => Some(Answer::Still {
                request: request.get().to_owned(),
                picture: jpeg.clone(),
                size: (*width, *height),
            }),
            Effect::Normal(FromMedia::StillFailed { request, reason }) => Some(Answer::Failed {
                request: request.get().to_owned(),
                reason: reason.clone(),
            }),
            _ => None,
        })
        .collect()
}

fn still(request: &str, picture: u8, size: (u32, u32)) -> Answer {
    Answer::Still {
        request: request.into(),
        picture: vec![picture],
        size,
    }
}

fn failed(request: &str, reason: &str) -> Answer {
    Answer::Failed {
        request: request.into(),
        reason: reason.into(),
    }
}

/// Lets every finished job reach the engine; the effects that follow.
fn arrive(engine: &mut Engine, maker: &Maker) -> Vec<Effect> {
    let outcomes = std::mem::take(&mut maker.model().outcomes);
    for outcome in outcomes {
        engine.still_finished(outcome);
    }
    engine.effects().collect()
}

fn take(engine: &mut Engine, request: &str, source: &str, side: u32) -> Vec<Effect> {
    take_with(engine, request, source, side, 500, NOW)
}

fn take_with(
    engine: &mut Engine,
    request: &str,
    source: &str,
    side: u32,
    deadline_ms: u32,
    now: Now,
) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "still.take", "request": request, "source": source, "maxWidth": side,
                "maxHeight": side, "maxPixels": 10_000_000, "quality": 80,
                "deadlineMs": deadline_ms }),
        &[],
        now,
    )
}

/// Takes a still and lets its job finish: the daemon's answers.
fn shot(engine: &mut Engine, maker: &Maker, request: &str, side: u32) -> Vec<Answer> {
    let mut effects = take(engine, request, "s1", side);
    effects.extend(arrive(engine, maker));
    answers(&effects)
}

fn keyframe_requests(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| {
            matches!(
                e,
                Effect::Normal(FromMedia::SourceKeyframe {
                    reason: KeyReason::Drop,
                    ..
                })
            )
        })
        .count()
}

/// A unit of encode `encode`: H.264 AVCC (codec 2) at `width` × ¾ width.
fn unit(picture: u8, encode: u8, key: bool, codec: u8, width: u16) -> MediaFrame {
    let mut frame = frame(1, u32::from(key), 1, vec![picture, encode]);
    frame.codec = codec;
    frame.encode = u32::from(encode);
    frame.width = width;
    frame.height = width / 4 * 3;
    frame
}

/// A keyframe with its configuration record, and a delta, of encode 1 at 640 px.
fn key(picture: u8) -> MediaFrame {
    let mut frame = unit(picture, 1, true, 2, 640);
    frame.description = record(2, 640);
    frame
}

fn delta(picture: u8) -> MediaFrame {
    unit(picture, 1, false, 2, 640)
}

fn producing(engine: &mut Engine) {
    open_tab(engine, "s1", 1, 9);
    hello(engine, 1, 9);
}

fn feed(engine: &mut Engine, frames: impl IntoIterator<Item = MediaFrame>) -> Vec<Effect> {
    frames
        .into_iter()
        .flat_map(|f| ingest(engine, 1, f, NOW))
        .collect()
}

fn jpeg(width: u32, height: u32) -> Vec<u8> {
    use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, StillCodec};
    let picture = CpuPicture::new(
        Size { width, height },
        PixelFormat::Rgb8,
        [Plane {
            data: vec![90; (width * height * 3) as usize],
            stride: width as usize * 3,
        }],
        0,
    );
    match picture.and_then(|p| StillCodec::encode(&mut CpuJpegCodec::default(), &p, 80)) {
        Ok(jpeg) => jpeg,
        Err(error) => panic!("{error}"),
    }
}

#[test]
fn a_screencast_picture_off_its_ingest_is_the_still_fitted_to_the_box() {
    let (mut engine, maker) = with_maker();
    send(
        &mut engine,
        json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": 1,
                "origin": { "kind": "tab-pictures" } }),
        &[9; 32],
        NOW,
    );
    assert!(engine.ingest_hello(1, &[9; 32]));
    let picture = jpeg(1200, 600);
    let screencast = |engine: &mut Engine, bytes: Vec<u8>| {
        let mut frame = frame(3, 1, 1, bytes);
        frame.codec = 7;
        ingest(engine, 1, frame, NOW)
    };
    screencast(&mut engine, picture.clone());
    assert_eq!(
        shot(&mut engine, &maker, "q1", 400),
        [Answer::Still {
            request: "q1".into(),
            picture: picture.clone(),
            size: (400, 200)
        }]
    );
    // Bytes that aren't a JPEG, with no size of their own: no picture rather than a guess.
    let mut junk = frame(3, 1, 1, b"not a jpeg".to_vec());
    junk.codec = 7;
    junk.width = 0;
    junk.height = 0;
    ingest(&mut engine, 1, junk, NOW);
    assert_eq!(
        shot(&mut engine, &maker, "q2", 400),
        [failed("q2", "no-picture")]
    );
}

#[test]
fn a_picture_captured_before_a_privacy_change_and_delivered_after_is_never_the_still() {
    let (mut engine, maker) = with_maker();
    send(
        &mut engine,
        json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": 1,
                "origin": { "kind": "tab-pictures" } }),
        &[9; 32],
        NOW,
    );
    assert!(engine.ingest_hello(1, &[9; 32]));
    let screencast = |engine: &mut Engine, bytes: Vec<u8>, epoch: u32| {
        let mut frame = frame(3, 1, epoch, bytes);
        frame.codec = 7;
        ingest(engine, 1, frame, NOW)
    };
    let now = jpeg(1200, 600);
    screencast(&mut engine, now.clone(), 2);
    // Captured in epoch 1 (before the change to epoch 2), delivered late.
    screencast(&mut engine, jpeg(800, 800), 1);
    assert_eq!(
        shot(&mut engine, &maker, "q1", 400),
        [Answer::Still {
            request: "q1".into(),
            picture: now,
            size: (400, 200)
        }]
    );
}

#[test]
fn a_picture_from_a_private_epoch_is_never_the_still_once_the_source_left_it_even_in_the_read_gap()
{
    for kind in ["tab-pictures", "user-tab"] {
        let (mut engine, maker) = with_maker();
        send(
            &mut engine,
            json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": 1,
                    "origin": { "kind": kind } }),
            &[9; 32],
            NOW,
        );
        assert!(engine.ingest_hello(1, &[9; 32]));
        let screencast = |engine: &mut Engine, bytes: Vec<u8>, epoch: u32, now: Now| {
            let mut frame = frame(3, 1, epoch, bytes);
            frame.codec = 7;
            ingest(engine, 1, frame, now)
        };
        // Epoch 1 is private: its picture is the still while the tab stays private (the
        // person's own requests are the daemon's grant).
        screencast(&mut engine, jpeg(1200, 600), 1, at(1_000));
        assert!(matches!(
            shot(&mut engine, &maker, "q1", 400).as_slice(),
            [Answer::Still { .. }]
        ));
        // The tab stops being private: epoch 2 follows a private one.
        send(
            &mut engine,
            json!({ "type": "source.epoch", "source": "s1", "seq": 1, "epoch": 2, "followsPrivate": true }),
            &[],
            at(2_000),
        );
        assert_eq!(
            shot(&mut engine, &maker, "q2", 400),
            [failed("q2", "no-picture")]
        );
        // Read 50 ms later, inside the read gap: it takes the private epoch, so it isn't kept.
        screencast(&mut engine, jpeg(800, 800), 2, at(2_050));
        assert_eq!(
            shot(&mut engine, &maker, "q3", 400),
            [failed("q3", "no-picture")]
        );
        // After the gap, the public picture is the still.
        let public = jpeg(1200, 600);
        screencast(&mut engine, public.clone(), 2, at(2_200));
        assert_eq!(
            shot(&mut engine, &maker, "q4", 400),
            [Answer::Still {
                request: "q4".into(),
                picture: public,
                size: (400, 200)
            }],
            "{kind}"
        );
    }
}

/// A JPEG source on ingest, opened in `epoch` (`private`: that epoch is private).
fn jpeg_source(engine: &mut Engine, epoch: u32, private: bool) {
    send(
        engine,
        json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": epoch,
                "private": private, "origin": { "kind": "tab-pictures" } }),
        &[9; 32],
        NOW,
    );
    assert!(engine.ingest_hello(1, &[9; 32]));
}

fn picture_in(engine: &mut Engine, picture: Vec<u8>, epoch: u32, now: Now) {
    let mut frame = frame(3, 1, epoch, picture);
    frame.codec = 7;
    ingest(engine, 1, frame, now);
}

fn fenced(engine: &mut Engine, maker: &Maker, request: &str, min_epoch: u32) -> Vec<Answer> {
    let mut effects = send(
        engine,
        json!({ "type": "still.take", "request": request, "source": "s1", "maxWidth": 400,
                "maxHeight": 400, "maxPixels": 10_000_000, "quality": 80, "deadlineMs": 500,
                "minEpoch": min_epoch }),
        &[],
        NOW,
    );
    effects.extend(arrive(engine, maker));
    answers(&effects)
}

#[test]
fn a_private_picture_in_flight_across_a_public_transition_is_never_a_fenced_still() {
    let (mut engine, maker) = with_maker();
    jpeg_source(&mut engine, 1, true);
    // Written while the tab was private (epoch 1), it reaches ace-media after the daemon made
    // the tab public (epoch 2) but before ace-media applied that.
    picture_in(&mut engine, jpeg(1200, 600), 1, at(1_000));
    assert_eq!(
        fenced(&mut engine, &maker, "q1", 2),
        [failed("q1", "private")]
    );
    // The public picture is the still.
    let public = jpeg(1200, 600);
    picture_in(&mut engine, public.clone(), 2, at(1_500));
    assert_eq!(
        fenced(&mut engine, &maker, "q2", 2),
        [Answer::Still {
            request: "q2".into(),
            picture: public,
            size: (400, 200)
        }]
    );
}

#[test]
fn a_source_opened_private_takes_its_next_epoch_as_following_a_private_one() {
    let (mut engine, maker) = with_maker();
    jpeg_source(&mut engine, 1, true);
    picture_in(&mut engine, jpeg(1200, 600), 1, at(1_000));
    // The next epoch arrives without saying it follows a private one: the open said so.
    send(
        &mut engine,
        json!({ "type": "source.epoch", "source": "s1", "seq": 1, "epoch": 2, "followsPrivate": false }),
        &[],
        at(2_000),
    );
    assert_eq!(
        shot(&mut engine, &maker, "q1", 400),
        [failed("q1", "no-picture")]
    );
    // Inside the read gap the private epoch is kept, so that picture isn't the still either.
    picture_in(&mut engine, jpeg(800, 800), 2, at(2_050));
    assert_eq!(
        shot(&mut engine, &maker, "q2", 400),
        [failed("q2", "no-picture")]
    );
}

#[test]
fn each_still_shows_the_latest_picture_of_the_stream() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1), delta(2), delta(3)]);
    assert_eq!(
        shot(&mut engine, &maker, "q1", 320),
        [still("q1", 3, (320, 240))]
    );
    feed(&mut engine, [delta(4)]);
    assert_eq!(
        shot(&mut engine, &maker, "q2", 320),
        [still("q2", 4, (320, 240))]
    );
    assert_eq!(
        shot(&mut engine, &maker, "q3", 320),
        [still("q3", 4, (320, 240))]
    );
    feed(&mut engine, [key(5), delta(6)]);
    assert_eq!(
        shot(&mut engine, &maker, "q4", 320),
        [still("q4", 6, (320, 240))]
    );
}

#[test]
fn a_keyframe_without_a_record_keeps_the_last_one_only_for_the_same_configuration() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    // Producers send the record only when it changes.
    feed(&mut engine, [unit(2, 1, true, 2, 640)]);
    assert_eq!(
        shot(&mut engine, &maker, "same", 1000),
        [still("same", 2, (640, 480))]
    );
    // Annex B HEVC at another size with its parameter sets in band: the old record isn't its.
    feed(
        &mut engine,
        [unit(3, 1, true, 3, 320), unit(4, 1, false, 3, 320)],
    );
    assert_eq!(
        shot(&mut engine, &maker, "annexb", 1000),
        [still("annexb", 4, (320, 240))]
    );
    // Length-prefixed again at a new size and without a record: nothing stale to decode with.
    feed(&mut engine, [unit(5, 1, true, 4, 800)]);
    assert_eq!(
        shot(&mut engine, &maker, "missing", 1000),
        [failed("missing", DECODE_FAILED)]
    );
}

#[test]
fn stills_follow_one_encode_when_several_are_interleaved() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    let mut small_key = unit(20, 2, true, 2, 320);
    small_key.description = record(2, 320);
    feed(
        &mut engine,
        [
            key(10),
            small_key,
            delta(11),
            unit(21, 2, false, 2, 320),
            delta(12),
        ],
    );
    // The latest keyframe's encode, and none of the other's deltas.
    assert_eq!(
        shot(&mut engine, &maker, "q1", 1000),
        [still("q1", 21, (320, 240))]
    );
    // The other encode's deltas, at another size, don't end the group either.
    feed(&mut engine, [delta(13), unit(22, 2, false, 2, 320)]);
    assert_eq!(
        shot(&mut engine, &maker, "q2", 1000),
        [still("q2", 22, (320, 240))]
    );
}

#[test]
fn a_group_too_long_to_hold_waits_for_a_keyframe_it_asks_for_once() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    feed(
        &mut engine,
        (0..super::super::stills::MAX_UNITS).map(|_| delta(2)),
    );
    let first = take(&mut engine, "q1", "s1", 320);
    let second = take(&mut engine, "q2", "s1", 320);
    assert_eq!(
        (keyframe_requests(&first), keyframe_requests(&second)),
        (1, 0)
    );
    assert!(answers(&arrive(&mut engine, &maker)).is_empty(), "waiting");
    feed(&mut engine, [key(3)]);
    assert_eq!(
        answers(&arrive(&mut engine, &maker)),
        [still("q1", 3, (320, 240)), still("q2", 3, (320, 240))]
    );
}

#[test]
fn a_still_past_its_deadline_fails_so_the_daemon_falls_back_and_its_late_result_is_dropped() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    take_with(&mut engine, "made", "s1", 320, 200, NOW);
    // Waiting for a keyframe that never comes counts too.
    feed(
        &mut engine,
        (0..=super::super::stills::MAX_UNITS).map(|_| delta(2)),
    );
    take_with(&mut engine, "waiting", "s1", 320, 300, NOW);
    engine.tick(at(NOW.mono_ms + 199));
    assert!(answers(&engine.effects().collect::<Vec<_>>()).is_empty());
    engine.tick(at(NOW.mono_ms + 300));
    assert_eq!(
        answers(&engine.effects().collect::<Vec<_>>()),
        [failed("waiting", "deadline"), failed("made", "deadline")]
    );
    assert!(answers(&arrive(&mut engine, &maker)).is_empty());
}

#[test]
fn a_failed_decode_drops_the_group_and_a_still_too_large_for_it_waits_for_a_keyframe() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    // A keyframe whose record doesn't fit it fails to decode.
    let mut broken = key(1);
    broken.description = record(2, 999);
    feed(&mut engine, [broken, delta(2)]);
    assert_eq!(
        shot(&mut engine, &maker, "q1", 160),
        [failed("q1", DECODE_FAILED)]
    );
    // The group is gone: the next still asks for a keyframe instead of decoding past the hole.
    assert_eq!(keyframe_requests(&take(&mut engine, "q2", "s1", 160)), 1);
    feed(&mut engine, [key(3)]);
    assert_eq!(
        answers(&arrive(&mut engine, &maker)),
        [still("q2", 3, (160, 120))]
    );
    // Larger than the group was decoded at: taken again from the next keyframe.
    let mut effects = take(&mut engine, "q3", "s1", 640);
    effects.extend(arrive(&mut engine, &maker));
    assert!(answers(&effects).is_empty());
    assert_eq!(keyframe_requests(&effects), 1);
    feed(&mut engine, [key(4)]);
    assert_eq!(
        answers(&arrive(&mut engine, &maker)),
        [still("q3", 4, (640, 480))]
    );
}

#[test]
fn requests_end_at_once_when_nothing_can_answer_them() {
    let (mut engine, maker) = with_maker();
    let unknown = take(&mut engine, "q0", "nope", 320);
    producing(&mut engine);
    let empty = take(&mut engine, "q1", "s1", 320);
    let bad_box = take(&mut engine, "q2", "s1", 1);
    feed(&mut engine, [key(1)]);
    maker.model().full = true;
    let busy = take(&mut engine, "q3", "s1", 320);
    let reasons: Vec<_> = [unknown, empty, bad_box, busy]
        .iter()
        .flat_map(|e| answers(e))
        .collect();
    assert_eq!(
        reasons,
        [
            failed("q0", "no-source"),
            failed("q1", "no-picture"),
            failed("q2", "invalid"),
            failed("q3", "busy")
        ]
    );
    // A refused job's units aren't lost: the next still still decodes from the keyframe.
    maker.model().full = false;
    assert_eq!(
        shot(&mut engine, &maker, "q4", 320),
        [still("q4", 1, (320, 240))]
    );
}

#[test]
fn closing_a_source_fails_its_stills_in_flight_and_their_late_results_never_arrive() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    take(&mut engine, "in-flight", "s1", 320);
    let closed = send(
        &mut engine,
        json!({ "type": "source.close", "source": "s1" }),
        &[],
        NOW,
    );
    assert_eq!(answers(&closed), [failed("in-flight", "source-closed")]);
    // Reopened under the same id: the old job's result belongs to nothing now.
    open_tab(&mut engine, "s1", 2, 8);
    assert!(answers(&arrive(&mut engine, &maker)).is_empty());
    hello(&mut engine, 2, 8);
    ingest(&mut engine, 2, key(5), NOW);
    assert_eq!(
        shot(&mut engine, &maker, "fresh", 320),
        [still("fresh", 5, (320, 240))]
    );
}

#[test]
fn shutdown_fails_every_still_still_open() {
    let (mut engine, _maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    take(&mut engine, "q1", "s1", 320);
    engine.finish();
    assert_eq!(
        answers(&engine.effects().collect::<Vec<_>>()),
        [failed("q1", "shutdown")]
    );
}

/// An Annex B H.264 keyframe of stream `stream`, picture `picture`: its parameter sets in band
/// when `in_band`.
fn annex_b_key(picture: u8, stream: u8, in_band: bool) -> MediaFrame {
    let mut payload = Vec::new();
    let mut nal = |bytes: &[u8]| {
        payload.extend_from_slice(&[0, 0, 0, 1]);
        payload.extend_from_slice(bytes);
    };
    if in_band {
        nal(&[0x67, 66, 0, 30, stream]);
        nal(&[0x68, stream]);
    }
    nal(&[0x65, stream, picture]);
    let mut frame = frame(1, 1, 1, payload);
    frame.width = 640;
    frame.height = 480;
    frame
}

#[test]
fn a_keyframe_without_parameter_sets_decodes_with_the_last_ones_the_stream_carried() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    // Stream A's record arrives as the frame's description.
    let mut first = annex_b_key(1, 0xa, false);
    let Some(record_a) = crate::record::video::avcc(&[0x67, 66, 0, 30, 0xa], &[0x68, 0xa]) else {
        panic!("avcC")
    };
    first.description = record_a;
    feed(&mut engine, [first]);
    assert_eq!(
        shot(&mut engine, &maker, "a", 1000),
        [still("a", 1, (640, 480))]
    );
    // The same configuration restarts as stream B, its parameter sets in band only.
    feed(&mut engine, [annex_b_key(2, 0xb, true)]);
    assert_eq!(
        shot(&mut engine, &maker, "b", 1000),
        [still("b", 2, (640, 480))]
    );
    // B's next keyframe carries neither: it needs B's parameter sets, not A's.
    feed(&mut engine, [annex_b_key(3, 0xb, false)]);
    assert_eq!(
        shot(&mut engine, &maker, "c", 1000),
        [still("c", 3, (640, 480))]
    );
}

#[test]
fn a_result_from_before_a_close_never_answers_a_reused_request_id() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    take(&mut engine, "r", "s1", 320);
    let closed = send(
        &mut engine,
        json!({ "type": "source.close", "source": "s1" }),
        &[],
        NOW,
    );
    assert_eq!(answers(&closed), [failed("r", "source-closed")]);
    open_tab(&mut engine, "s1", 2, 8);
    hello(&mut engine, 2, 8);
    ingest(&mut engine, 2, key(5), NOW);
    take(&mut engine, "r", "s1", 320);
    // The closed source's job finishes first, then the new one's.
    assert_eq!(
        answers(&arrive(&mut engine, &maker)),
        [still("r", 5, (320, 240))]
    );
}

fn stamped(mut frame: MediaFrame, epoch: u32) -> MediaFrame {
    frame.epoch = epoch;
    frame
}

fn poster(engine: &mut Engine, request: &str, clear: Value) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "still.poster", "request": request, "source": "s1", "width": 320,
                "height": 240, "deadlineMs": 500, "clear": clear }),
        &[],
        NOW,
    )
}

#[test]
fn a_poster_comes_only_from_a_group_whose_every_epoch_was_decided_clear() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    // The keyframe is from epoch 1; a delta from epoch 2 carries content into the same picture.
    feed(&mut engine, [stamped(key(1), 1), stamped(delta(2), 2)]);
    let mut effects = poster(&mut engine, "p1", json!([[1, 1]]));
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(answers(&effects), [failed("p1", "private")]);
    // Nothing decided clear: nothing at all.
    let mut effects = poster(&mut engine, "p2", json!([]));
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(answers(&effects), [failed("p2", "private")]);
    let mut effects = poster(&mut engine, "p3", json!([[1, 2]]));
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(answers(&effects), [still("p3", 2, (320, 240))]);
    // Agents' stills are the daemon's grant, as before: unaffected.
    assert_eq!(
        shot(&mut engine, &maker, "q1", 320),
        [still("q1", 2, (320, 240))]
    );
}

#[test]
fn a_poster_whose_epoch_is_discarded_while_it_is_made_never_arrives() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [stamped(key(1), 3)]);
    // The subscribe came while the daemon still took epoch 3 for clear; the job is with the maker.
    let mut effects = poster(&mut engine, "p1", json!([[3, 3]]));
    // Then epoch 3 is decided discarded: it overlapped a private moment.
    effects.extend(send(
        &mut engine,
        json!({ "type": "record.epochs", "source": "s1", "recording": "r1", "seq": 0,
                "decided": 3, "clear": [], "discard": [[3, 3]] }),
        &[],
        NOW,
    ));
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(answers(&effects), [failed("p1", "private")]);
    // And a later poster from that picture is refused, whatever the request says is clear.
    let mut effects = poster(&mut engine, "p2", json!([[0, 10]]));
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(answers(&effects), [failed("p2", "private")]);
}

/// A still that must come from a picture arriving after it was asked (`still.take.fresh`).
fn take_fresh(engine: &mut Engine, request: &str, deadline_ms: u32, now: Now) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "still.take", "request": request, "source": "s1", "maxWidth": 320,
                "maxHeight": 320, "maxPixels": 10_000_000, "quality": 80,
                "deadlineMs": deadline_ms, "fresh": true }),
        &[],
        now,
    )
}

#[test]
fn a_fresh_still_is_never_the_picture_cached_before_it_was_asked() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    // The screen as it was before the agent's input.
    feed(&mut engine, [key(1), delta(2)]);
    let mut effects = take_fresh(&mut engine, "q1", 500, NOW);
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(
        answers(&effects),
        [],
        "the cached picture predates the request"
    );
    // The next picture, after the input: the still is it.
    let mut effects = feed(&mut engine, [delta(3)]);
    effects.extend(arrive(&mut engine, &maker));
    assert_eq!(answers(&effects), [still("q1", 3, (320, 240))]);
}

#[test]
fn a_fresh_still_with_no_new_picture_by_its_deadline_fails_for_the_source_to_answer() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    feed(&mut engine, [key(1)]);
    take_fresh(&mut engine, "q1", 500, NOW);
    engine.tick(at(NOW.mono_ms + 600));
    let mut effects: Vec<Effect> = engine.effects().collect();
    effects.extend(arrive(&mut engine, &maker));
    assert!(matches!(
        answers(&effects).as_slice(),
        [Answer::Failed { .. }]
    ));
}
