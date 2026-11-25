// SPDX-License-Identifier: Apache-2.0
//! The moved cases of `simulator-frames.test.ts` (D3.3), beside the state machine they name.

use super::*;

/// A 20x10 baseline JPEG: APP0, a frame header, one scan and its end marker.
fn tiny() -> Vec<u8> {
    let mut out = vec![0xff, 0xd8];
    out.extend([0xff, 0xe0, 0x00, 0x04, b'A', b'B']);
    out.extend([0xff, 0xc0, 0x00, 0x0b, 8, 0, 10, 0, 20, 1, 1, 0x11, 0]);
    out.extend([0xff, 0xda, 0x00, 0x04, 0, 0]);
    out.extend([1, 2, 3]);
    out.extend([0xff, 0xd9]);
    out
}

fn image(width: u32, height: u32) -> Image {
    Image {
        bytes: tiny(),
        width,
        height,
    }
}

fn settings(max_width: u32, max_height: u32) -> FrameSettings {
    FrameSettings {
        fps: 30,
        max_width,
        max_height,
    }
}

/// Asks for a still and drains it, returning what the drain produced.
fn still(frames: &mut SimulatorFrames) -> Vec<Effect> {
    let (replay, effects) = frames.replay().expect("asks");
    assert!(matches!(replay, Replay::Waiting { .. }));
    assert!(effects.contains(&Effect::Drain));
    frames.step()
}

#[test]
fn a_picture_over_the_box_is_refused_as_too_large_and_the_capture_goes_on() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    frames.hold(image(1206, 2622));
    let effects = still(&mut frames);
    assert_eq!(
        effects,
        vec![Effect::RefuseStill {
            waiter: 0,
            too_large: StillTooLarge {
                width: 1206,
                height: 2622
            }
        }]
    );
    frames.hold(image(100, 200));
    let effects = still(&mut frames);
    assert_eq!(
        effects,
        vec![
            Effect::Publish(image(100, 200)),
            Effect::Resolve { waiter: 1 }
        ]
    );
}

#[test]
fn a_picture_inside_the_box_is_published_as_it_came_with_its_own_size() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    frames.hold(image(600, 1300));
    let effects = still(&mut frames);
    match &effects[0] {
        Effect::Publish(published) => assert_eq!(published, &image(600, 1300)),
        other => panic!("unexpected first effect: {other:?}"),
    }
    assert_eq!(effects[1], Effect::Resolve { waiter: 0 });
}

#[test]
fn a_picture_cut_short_is_a_failure_every_waiting_still_sees_never_a_publish() {
    let mut frames = SimulatorFrames::new(settings(100, 100));
    let mut broken = tiny();
    broken.truncate(broken.len() - 2);
    frames.hold(Image {
        bytes: broken,
        width: 1206,
        height: 2622,
    });
    let effects = still(&mut frames);
    assert_eq!(effects.len(), 1);
    match &effects[0] {
        Effect::Fail { failure, waiters } => {
            assert_eq!(failure.code, crate::platform::Code::InvalidData);
            assert_eq!(
                failure.message,
                Refusal::word("simulatorIncompletePicture").message
            );
            assert_eq!(*waiters, vec![0]);
        }
        other => panic!("unexpected effect: {other:?}"),
    }
    assert_eq!(frames.waiting(), 0);
}

#[test]
fn the_rate_limit_publishes_at_the_streams_fps_and_keeps_the_latest_picture() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    let first = frames.push(1_000.0, image(10, 20));
    assert!(first.contains(&Effect::Drain));
    assert_eq!(frames.step(), vec![Effect::Publish(image(10, 20))]);
    let second = frames.push(1_010.0, image(30, 40));
    match second.as_slice() {
        [Effect::Schedule { after_ms }] => {
            assert!((after_ms - (1000.0 / 30.0 - 10.0)).abs() < 1e-9);
        }
        other => panic!("unexpected effects: {other:?}"),
    }
    let fired = frames.timer(1_033.333);
    assert_eq!(fired, vec![Effect::Drain]);
    assert_eq!(frames.step(), vec![Effect::Publish(image(30, 40))]);
}

#[test]
fn stills_asked_before_one_drain_share_it_and_the_65th_is_refused() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    frames.hold(image(20, 10));
    for index in 0..WAITER_LIMIT {
        let (replay, effects) = frames.replay().expect("asks");
        assert!(matches!(replay, Replay::Waiting { .. }));
        if index == 0 {
            assert!(effects.contains(&Effect::Drain));
        }
    }
    assert!(frames.replay().is_err(), "the 65th still waits too many");
    let effects = frames.step();
    assert_eq!(
        effects
            .iter()
            .filter(|effect| matches!(effect, Effect::Publish(_)))
            .count(),
        1
    );
    assert_eq!(frames.waiting(), 0);
}

#[test]
fn a_change_of_settings_drops_the_pending_picture_and_serves_the_still_the_new_one() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    frames.hold(image(2500, 1000));
    let (replay, mut effects) = frames.replay().expect("asks");
    assert!(matches!(replay, Replay::Waiting { waiter: 0 }));
    // The box grows before the drain runs: the same picture now fits.
    effects.extend(
        frames
            .configure(settings(2500, 2160))
            .expect("configures")
            .1,
    );
    effects.extend(frames.step());
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, Effect::Publish(_))),
        "the still is served at the new settings"
    );
}

#[test]
fn stopping_refuses_every_still_and_cancels_the_rate_timer() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    assert!(frames.push(1_000.0, image(10, 20)).contains(&Effect::Drain));
    frames.step();
    assert!(matches!(
        frames.push(1_001.0, image(10, 20)).as_slice(),
        [Effect::Schedule { .. }]
    ));
    frames.hold(image(10, 20));
    let (replay, _) = frames.replay().expect("asks");
    assert!(matches!(replay, Replay::Waiting { waiter: 0 }));
    let effects = frames.stop();
    assert_eq!(
        effects,
        vec![Effect::RefuseStopped { waiter: 0 }, Effect::CancelTimer]
    );
    assert_eq!(frames.step(), Vec::new());
    assert_eq!(frames.replay().expect("ready").0, Replay::Ready);
}

#[test]
fn a_still_with_no_picture_to_wait_for_is_ready_at_once() {
    let mut frames = SimulatorFrames::new(settings(1920, 2160));
    assert_eq!(frames.replay().expect("asks").0, Replay::Ready);
    frames.hold(image(10, 20));
    frames.forget();
    assert_eq!(frames.replay().expect("asks").0, Replay::Ready);
}
