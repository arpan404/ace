// SPDX-License-Identifier: Apache-2.0
//! `image.job` through the engine: handed to the image threads once, answered once, and a
//! result that comes after a cancel, a deadline or a shutdown is dropped.
use super::*;
use crate::engine::images::{ImageOutcome, MAX_JOBS};
use media_wire::image::{DoneFormat, ImageFailure, SourceFormat, SourceImage};

fn job(request: &str, deadline_ms: u32) -> Value {
    json!({ "type": "image.job", "request": request, "deadlineMs": deadline_ms,
        "inputs": [{ "kind": "bytes", "bytes": 2 }],
        "op": { "op": "probe", "maxPixels": 4096 } })
}

/// The tokens of the jobs handed to the image threads.
fn handed(effects: &[Effect]) -> Vec<u64> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Image(work) => Some(work.token),
            _ => None,
        })
        .collect()
}

/// `(request, reason)` of each `image.failed`, and the request of each `image.done`.
fn answers(effects: &[Effect]) -> Vec<(String, Option<ImageFailure>)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::ImageFailed {
                request, reason, ..
            }) => Some((request.get().to_owned(), Some(*reason))),
            Effect::NormalWith(FromMedia::ImageDone { request, .. }, _) => {
                Some((request.get().to_owned(), None))
            }
            _ => None,
        })
        .collect()
}

fn done(token: u64) -> ImageOutcome {
    ImageOutcome {
        token,
        result: Ok(media_image::Done {
            width: 2,
            height: 1,
            format: DoneFormat::None,
            source: SourceImage {
                format: SourceFormat::Png,
                width: 2,
                height: 1,
                orientation: 1,
            },
            bytes: Vec::new(),
        }),
    }
}

fn finished(engine: &mut Engine, outcome: ImageOutcome) -> Vec<Effect> {
    engine.image_finished(outcome);
    engine.effects().collect()
}

#[test]
fn a_job_goes_to_the_image_threads_and_its_result_answers_it_once() {
    let mut engine = engine();
    let effects = send(&mut engine, job("i1", 1000), &[1, 2], NOW);
    let tokens = handed(&effects);
    assert_eq!(tokens.len(), 1);
    assert!(answers(&effects).is_empty());
    assert_eq!(
        answers(&finished(&mut engine, done(tokens[0]))),
        [("i1".into(), None)]
    );
    // The same result again, or one for a token nobody waits on, answers nothing.
    assert!(answers(&finished(&mut engine, done(tokens[0]))).is_empty());
    assert!(answers(&finished(&mut engine, done(999))).is_empty());
    assert_eq!(engine.images_waiting(), 0);
}

#[test]
fn a_cancelled_job_is_answered_cancelled_and_its_late_result_dropped() {
    let mut engine = engine();
    let token = handed(&send(&mut engine, job("i1", 1000), &[1, 2], NOW))[0];
    let effects = send(
        &mut engine,
        json!({ "type": "image.cancel", "request": "i1" }),
        &[],
        NOW,
    );
    assert_eq!(
        answers(&effects),
        [("i1".into(), Some(ImageFailure::Cancelled))]
    );
    assert!(answers(&finished(&mut engine, done(token))).is_empty());
    // A reused id is a new job: the old token's result still doesn't answer it.
    let again = handed(&send(&mut engine, job("i1", 1000), &[1, 2], NOW))[0];
    assert_ne!(again, token);
    assert!(answers(&finished(&mut engine, done(token))).is_empty());
    assert_eq!(
        answers(&finished(&mut engine, done(again))),
        [("i1".into(), None)]
    );
}

#[test]
fn a_job_past_its_deadline_fails_on_the_tick_whether_or_not_it_started() {
    let mut engine = engine();
    let token = handed(&send(&mut engine, job("slow", 200), &[1, 2], NOW))[0];
    engine.tick(at(NOW.mono_ms + 199));
    assert!(answers(&engine.effects().collect::<Vec<_>>()).is_empty());
    engine.tick(at(NOW.mono_ms + 200));
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(
        answers(&effects),
        [("slow".into(), Some(ImageFailure::Deadline))]
    );
    assert!(answers(&finished(&mut engine, done(token))).is_empty());
}

#[test]
fn past_the_job_bound_a_job_is_refused_busy_and_a_running_id_is_refused_invalid() {
    let mut engine = engine();
    for n in 0..MAX_JOBS {
        assert_eq!(
            handed(&send(
                &mut engine,
                job(&format!("i{n}"), 1000),
                &[1, 2],
                NOW
            ))
            .len(),
            1
        );
    }
    let effects = send(&mut engine, job("one-more", 1000), &[1, 2], NOW);
    assert!(handed(&effects).is_empty());
    assert_eq!(
        answers(&effects),
        [("one-more".into(), Some(ImageFailure::Busy))]
    );
    let effects = send(&mut engine, job("i0", 1000), &[1, 2], NOW);
    assert_eq!(
        answers(&effects),
        [("i0".into(), Some(ImageFailure::Invalid))]
    );
}

#[test]
fn shutdown_fails_every_waiting_job() {
    let mut engine = engine();
    send(&mut engine, job("a", 1000), &[1, 2], NOW);
    send(&mut engine, job("b", 1000), &[1, 2], NOW);
    engine.finish();
    let effects: Vec<Effect> = engine.effects().collect();
    assert_eq!(
        answers(&effects),
        [
            ("a".into(), Some(ImageFailure::Shutdown)),
            ("b".into(), Some(ImageFailure::Shutdown))
        ]
    );
}
