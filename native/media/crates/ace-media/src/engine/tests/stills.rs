// SPDX-License-Identifier: Apache-2.0
//! `still.take` against a recording maker: what each job carries, and every way a request
//! ends so the daemon can fall back in time.
use super::super::stills::{
    DECODE_FAILED, Made, NEEDS_KEYFRAME, StillInput, StillJob, StillMaker, StillOutcome,
};
use super::*;
use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec};
use media_wire::control::{Backend, KeyReason, SourceStep, Step};
use std::sync::{Arc, Mutex};

/// What a job carried, as the test reads it back.
#[derive(Debug, PartialEq)]
enum Seen {
    Jpeg {
        request: String,
        target: (u32, u32),
    },
    Video {
        request: String,
        group: u64,
        units: Vec<(bool, u8)>,
        target: (u32, u32),
    },
}

#[derive(Clone, Default)]
struct Maker {
    jobs: Arc<Mutex<Vec<Seen>>>,
    forgotten: Arc<Mutex<Vec<u32>>>,
    full: Arc<Mutex<bool>>,
}

impl Maker {
    fn jobs(&self) -> Vec<Seen> {
        std::mem::take(&mut *self.jobs.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl StillMaker for Maker {
    fn take(&mut self, job: StillJob) -> Result<(), StillJob> {
        if *self.full.lock().unwrap_or_else(|e| e.into_inner()) {
            return Err(job);
        }
        let target = (job.target.width, job.target.height);
        let request = job.request.get().to_owned();
        let seen = match job.input {
            StillInput::Jpeg { .. } => Seen::Jpeg { request, target },
            StillInput::Video { group, units, .. } => Seen::Video {
                request,
                group,
                // Each unit's key flag and first payload byte (its id in these tests).
                units: units.iter().map(|u| (u.key, u.payload[0])).collect(),
                target,
            },
        };
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(seen);
        Ok(())
    }
    fn forget(&mut self, stream: u32) {
        self.forgotten
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(stream);
    }
}

fn with_maker() -> (Engine, Maker) {
    let maker = Maker::default();
    (engine().with_stills(Box::new(maker.clone())), maker)
}

fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let size = Size { width, height };
    let picture = CpuPicture::new(
        size,
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

fn take(engine: &mut Engine, request: &str, source: &str, side: u32, now: Now) -> Vec<Effect> {
    take_with(engine, request, source, side, 500, now)
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

fn failures(effects: &[Effect]) -> Vec<(String, String)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::StillFailed { request, reason }) => {
                Some((request.get().to_owned(), reason.clone()))
            }
            _ => None,
        })
        .collect()
}

fn keyframe_requests(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| {
            matches!(
                e,
                Effect::Normal(FromMedia::SourceKeyframe {
                    reason: KeyReason::Drop,
                    encode: 7,
                    ..
                })
            )
        })
        .count()
}

/// A 640×480 video unit whose payload starts with `id`.
fn video(id: u8, key: bool) -> MediaFrame {
    let mut unit = frame(1, u32::from(key), 1, vec![id; 64]);
    unit.width = 640;
    unit.height = 480;
    unit
}

fn producing(engine: &mut Engine) {
    open_tab(engine, "s1", 1, 9);
    hello(engine, 1, 9);
}

fn finish(engine: &mut Engine, request: &str, result: Result<Made, String>) -> Vec<Effect> {
    engine.still_finished(StillOutcome {
        request: Id::new(request.to_owned()).unwrap_or_else(|_| unreachable!()),
        result,
    });
    engine.effects().collect()
}

#[test]
fn a_jpeg_sources_still_is_fitted_to_the_box_and_answered_with_the_jpeg_and_its_steps() {
    let (mut engine, maker) = with_maker();
    open_tab(&mut engine, "s1", 1, 9);
    send(
        &mut engine,
        json!({ "type": "source.picture", "source": "s1", "ageMs": 0, "epoch": 1 }),
        &jpeg(1200, 600),
        NOW,
    );
    assert!(take(&mut engine, "q1", "s1", 400, NOW).is_empty());
    assert_eq!(
        maker.jobs(),
        [Seen::Jpeg {
            request: "q1".into(),
            target: (400, 200)
        }]
    );
    let steps = vec![SourceStep {
        step: Step::JpegEncode,
        backend: Backend::Cpu,
        hardware: false,
        readbacks: 0,
        uploads: 0,
    }];
    let made = Made {
        jpeg: vec![0xff, 0xd8, 1, 2],
        size: Size {
            width: 400,
            height: 200,
        },
        steps: steps.clone(),
    };
    let done = finish(&mut engine, "q1", Ok(made));
    let [
        Effect::NormalWith(
            FromMedia::StillDone {
                request,
                width,
                height,
                steps: sent,
            },
            jpeg,
        ),
    ] = done.as_slice()
    else {
        panic!("expected still.done, got {done:?}")
    };
    assert_eq!((request.get(), *width, *height), ("q1", 400, 200));
    assert_eq!(
        (sent, jpeg.as_slice()),
        (&steps, [0xff, 0xd8, 1, 2].as_slice())
    );
}

#[test]
fn a_video_source_hands_its_maker_only_the_units_since_the_last_still_and_restarts_at_a_keyframe() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    for (id, key) in [(1, true), (2, false), (3, false)] {
        ingest(&mut engine, 1, video(id, key), NOW);
    }
    take(&mut engine, "q1", "s1", 320, NOW);
    ingest(&mut engine, 1, video(4, false), NOW);
    take(&mut engine, "q2", "s1", 320, NOW);
    take(&mut engine, "q3", "s1", 320, NOW);
    ingest(&mut engine, 1, video(5, true), NOW);
    ingest(&mut engine, 1, video(6, false), NOW);
    take(&mut engine, "q4", "s1", 320, NOW);
    let groups: Vec<_> = maker
        .jobs()
        .into_iter()
        .map(|seen| match seen {
            Seen::Video {
                group,
                units,
                target,
                ..
            } => (group, units, target),
            other => panic!("expected video, got {other:?}"),
        })
        .collect();
    assert_eq!(
        groups,
        [
            (1, vec![(true, 1), (false, 2), (false, 3)], (320, 240)),
            (1, vec![(false, 4)], (320, 240)),
            (1, vec![], (320, 240)),
            (2, vec![(true, 5), (false, 6)], (320, 240)),
        ]
    );
}

#[test]
fn a_group_too_long_to_hold_waits_for_a_keyframe_it_asks_for_once() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    ingest(&mut engine, 1, video(1, true), NOW);
    for _ in 0..super::super::stills::MAX_UNITS {
        ingest(&mut engine, 1, video(2, false), NOW);
    }
    let first = take(&mut engine, "q1", "s1", 320, NOW);
    let second = take(&mut engine, "q2", "s1", 320, NOW);
    assert_eq!(
        (keyframe_requests(&first), keyframe_requests(&second)),
        (1, 0)
    );
    assert!(
        maker.jobs().is_empty(),
        "nothing to decode until the keyframe"
    );
    ingest(&mut engine, 1, video(3, true), NOW);
    let requests: Vec<_> = maker
        .jobs()
        .into_iter()
        .map(|seen| match seen {
            Seen::Video { request, units, .. } => (request, units),
            other => panic!("expected video, got {other:?}"),
        })
        .collect();
    // The first job carries the keyframe; the second continues from it.
    assert_eq!(
        requests,
        [("q1".into(), vec![(true, 3)]), ("q2".into(), vec![])]
    );
}

#[test]
fn a_still_past_its_deadline_fails_so_the_daemon_falls_back_and_its_late_result_is_dropped() {
    let (mut engine, _maker) = with_maker();
    producing(&mut engine);
    ingest(&mut engine, 1, video(1, true), NOW);
    take_with(&mut engine, "made", "s1", 320, 200, NOW);
    // Waiting for a keyframe that never comes counts too.
    for _ in 0..=super::super::stills::MAX_UNITS {
        ingest(&mut engine, 1, video(2, false), NOW);
    }
    take_with(&mut engine, "waiting", "s1", 320, 300, NOW);
    engine.tick(at(NOW.mono_ms + 199));
    assert!(failures(&engine.effects().collect::<Vec<_>>()).is_empty());
    engine.tick(at(NOW.mono_ms + 300));
    let failed = failures(&engine.effects().collect::<Vec<_>>());
    assert_eq!(
        failed,
        [
            ("waiting".into(), "deadline".into()),
            ("made".into(), "deadline".into())
        ]
    );
    assert!(finish(&mut engine, "made", Err("too late".into())).is_empty());
}

#[test]
fn a_failed_decode_drops_the_group_and_a_still_too_large_for_it_waits_for_a_keyframe() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    ingest(&mut engine, 1, video(1, true), NOW);
    take(&mut engine, "q1", "s1", 160, NOW);
    let failed = finish(&mut engine, "q1", Err(DECODE_FAILED.into()));
    assert_eq!(failures(&failed), [("q1".into(), DECODE_FAILED.into())]);
    // The group is gone: the next still asks for a keyframe instead of decoding past the hole.
    assert_eq!(
        keyframe_requests(&take(&mut engine, "q2", "s1", 160, NOW)),
        1
    );
    ingest(&mut engine, 1, video(2, true), NOW);
    maker.jobs();
    finish(&mut engine, "q2", Err("decode-unavailable".into()));
    // A still larger than the group was decoded at is taken again from the next keyframe.
    take(&mut engine, "q3", "s1", 640, NOW);
    maker.jobs();
    let retried = finish(&mut engine, "q3", Err(NEEDS_KEYFRAME.into()));
    assert!(failures(&retried).is_empty());
    assert_eq!(keyframe_requests(&retried), 1);
    ingest(&mut engine, 1, video(3, true), NOW);
    let again = maker.jobs();
    assert!(
        matches!(again.as_slice(), [Seen::Video { request, target: (640, 480), .. }] if request == "q3")
    );
}

#[test]
fn requests_end_at_once_when_nothing_can_answer_them() {
    let (mut engine, maker) = with_maker();
    let unknown = take(&mut engine, "q0", "nope", 320, NOW);
    producing(&mut engine);
    let empty = take(&mut engine, "q1", "s1", 320, NOW);
    let bad_box = take(&mut engine, "q2", "s1", 1, NOW);
    ingest(&mut engine, 1, video(1, true), NOW);
    *maker.full.lock().unwrap_or_else(|e| e.into_inner()) = true;
    let busy = take(&mut engine, "q3", "s1", 320, NOW);
    let reasons: Vec<_> = [unknown, empty, bad_box, busy]
        .iter()
        .flat_map(|e| failures(e))
        .map(|(_, reason)| reason)
        .collect();
    assert_eq!(reasons, ["no-source", "no-picture", "invalid", "busy"]);
    // A refused job's units aren't lost: the next still still starts at the keyframe.
    *maker.full.lock().unwrap_or_else(|e| e.into_inner()) = false;
    take(&mut engine, "q4", "s1", 320, NOW);
    assert!(
        matches!(maker.jobs().as_slice(), [Seen::Video { units, .. }] if units == &[(true, 1)])
    );
}

#[test]
fn closing_a_source_fails_its_waiting_stills_and_drops_its_decoder() {
    let (mut engine, maker) = with_maker();
    producing(&mut engine);
    ingest(&mut engine, 1, video(1, true), NOW);
    for _ in 0..=super::super::stills::MAX_UNITS {
        ingest(&mut engine, 1, video(2, false), NOW);
    }
    take(&mut engine, "q1", "s1", 320, NOW);
    let closed = send(
        &mut engine,
        json!({ "type": "source.close", "source": "s1" }),
        &[],
        NOW,
    );
    assert_eq!(failures(&closed), [("q1".into(), "source-closed".into())]);
    assert_eq!(
        *maker.forgotten.lock().unwrap_or_else(|e| e.into_inner()),
        [1]
    );
}

#[test]
fn shutdown_fails_every_still_still_open() {
    let (mut engine, _maker) = with_maker();
    producing(&mut engine);
    ingest(&mut engine, 1, video(1, true), NOW);
    take(&mut engine, "q1", "s1", 320, NOW);
    engine.finish();
    let failed = failures(&engine.effects().collect::<Vec<_>>());
    assert_eq!(failed, [("q1".into(), "shutdown".into())]);
}
