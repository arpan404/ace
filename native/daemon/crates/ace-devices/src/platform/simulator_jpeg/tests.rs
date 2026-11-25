// SPDX-License-Identifier: Apache-2.0
//! The moved cases of `simulator-jpeg.test.ts` (D3.3), beside the controller they name: the
//! HTTP request is the test's to answer, the clock is passed in and the frame gate's microtask
//! is `step`.

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

fn part(image: &[u8]) -> Vec<u8> {
    format!(
        "--frame\r\ncontent-length: {}\r\ncontent-type: image/jpeg\r\n\r\n",
        image.len()
    )
    .into_bytes()
    .into_iter()
    .chain(image.iter().copied())
    .collect()
}

fn settings() -> FrameSettings {
    FrameSettings {
        fps: 30,
        max_width: 1920,
        max_height: 2160,
    }
}

fn stills() -> FrameSettings {
    FrameSettings {
        fps: 2,
        ..settings()
    }
}

/// A controller whose first request serve-sim has accepted.
fn started() -> (SimulatorJpeg, u64) {
    let mut jpeg = SimulatorJpeg::new("http://127.0.0.1:1/stream", settings());
    let (request, actions) = jpeg.start();
    assert!(matches!(actions.as_slice(), [Action::OpenRequest { .. }]));
    let actions = jpeg.response(
        request,
        true,
        Some("multipart/x-mixed-replace; boundary=frame"),
    );
    assert_eq!(actions, vec![Action::RequestReady { request }]);
    (jpeg, request)
}

/// Stills mode with the stream closed, as a capture nobody watches sits.
fn idle() -> SimulatorJpeg {
    let (mut jpeg, _) = started();
    let (still, actions) = jpeg.configure(stills(), true);
    assert_eq!(
        actions.last(),
        Some(&Action::SettleStill {
            still,
            outcome: Ok(())
        })
    );
    assert!(actions.contains(&Action::AbortRequest { request: 0 }));
    jpeg
}

fn settled(actions: &[Action]) -> Vec<(u64, Result<(), Reason>)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::SettleStill { still, outcome } => Some((*still, outcome.clone())),
            _ => None,
        })
        .collect()
}

fn published(actions: &[Action]) -> Vec<&Image> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Frames(super::super::simulator_frames::Effect::Publish(image)) => Some(image),
            _ => None,
        })
        .collect()
}

#[test]
fn a_simulator_nobody_watches_takes_no_pictures_until_an_agent_asks() {
    let mut jpeg = idle();
    assert_eq!(jpeg.waiting(), (0, 0));
    // Nothing is delivered once the still stream closed.
    assert_eq!(jpeg.chunk(0, &part(&tiny()), 0.0), Vec::new());
    // A still opens serve-sim, takes the current screen and closes it again.
    let (still, actions) = jpeg.replay().expect("asks");
    assert!(matches!(
        actions.first(),
        Some(Action::OpenRequest { request: 1, .. })
    ));
    jpeg.response(1, true, Some("multipart/x-mixed-replace; boundary=frame"));
    let received = jpeg.chunk(1, &part(&tiny()), 0.0);
    assert_eq!(
        received[0],
        Action::Source {
            width: 20,
            height: 10
        }
    );
    assert!(published(&received).is_empty(), "held until the still asks");
    assert!(received.contains(&Action::AbortRequest { request: 1 }));
    let drained = jpeg.step();
    assert_eq!(published(&drained).len(), 1);
    assert_eq!(settled(&drained), vec![(still, Ok(()))]);
}

#[test]
fn a_still_whose_request_serve_sim_never_answers_gives_up_and_the_next_one_asks_again() {
    let mut jpeg = idle();
    let (still, actions) = jpeg.replay().expect("asks");
    let ask = actions
        .iter()
        .find_map(|action| match action {
            Action::ScheduleAsk { ask, after_ms } => {
                assert_eq!(*after_ms, STILL_TIMEOUT_MS);
                Some(*ask)
            }
            _ => None,
        })
        .expect("a time limit");
    assert!(matches!(
        actions.as_slice(),
        [Action::OpenRequest { request: 1, .. }, ..]
    ));
    let expired = jpeg.timeout(ask);
    assert_eq!(
        settled(&expired),
        vec![(
            still,
            Err(Reason::text("The Simulator sent no picture in time"))
        )]
    );
    assert!(expired.contains(&Action::AbortRequest { request: 1 }));
    // The unanswered request is cancelled, not left open for later stills.
    assert!(jpeg.timeout(ask).is_empty());
    let (still, actions) = jpeg.replay().expect("asks again");
    assert!(matches!(
        actions.first(),
        Some(Action::OpenRequest { request: 2, .. })
    ));
    jpeg.response(2, true, Some("multipart/x-mixed-replace; boundary=frame"));
    let received = jpeg.chunk(2, &part(&tiny()), 0.0);
    let drained = jpeg.step();
    assert_eq!(published(&received).len() + published(&drained).len(), 1);
    let settled_all = settled(&received)
        .into_iter()
        .chain(settled(&drained))
        .collect::<Vec<_>>();
    assert!(settled_all.contains(&(still, Ok(()))));
}

#[test]
fn serve_sim_answering_after_the_still_gave_up_publishes_nothing_from_that_late_answer() {
    let mut jpeg = idle();
    let (_, actions) = jpeg.replay().expect("asks");
    let ask = actions
        .iter()
        .find_map(|action| match action {
            Action::ScheduleAsk { ask, .. } => Some(*ask),
            _ => None,
        })
        .expect("a time limit");
    jpeg.timeout(ask);
    assert_eq!(jpeg.chunk(1, &part(&tiny()), 0.0), Vec::new());
    let late = jpeg.response(1, true, Some("multipart/x-mixed-replace; boundary=frame"));
    assert_eq!(
        late,
        vec![
            Action::AbortRequest { request: 1 },
            Action::RequestFailed {
                request: 1,
                reason: Reason::text("Simulator stream closed")
            }
        ]
    );
    assert_eq!(jpeg.step(), Vec::new());
}

#[test]
fn stills_asked_together_share_one_picture_from_serve_sim() {
    let mut jpeg = idle();
    let (first, opened) = jpeg.replay().expect("asks");
    assert!(matches!(
        opened.first(),
        Some(Action::OpenRequest { request: 1, .. })
    ));
    let (second, again) = jpeg.replay().expect("asks");
    assert_eq!(again[0], Action::AwaitRequest { request: 1 });
    jpeg.response(1, true, Some("multipart/x-mixed-replace; boundary=frame"));
    let received = jpeg.chunk(1, &part(&tiny()), 0.0);
    let drained = jpeg.step();
    assert_eq!(published(&received).len() + published(&drained).len(), 1);
    let all = settled(&received)
        .into_iter()
        .chain(settled(&drained))
        .collect::<Vec<_>>();
    assert!(all.contains(&(first, Ok(()))));
    assert!(all.contains(&(second, Ok(()))));
}

#[test]
fn a_still_never_takes_a_picture_that_began_arriving_before_it_asked() {
    let mut jpeg = idle();
    let (first, _) = jpeg.replay().expect("asks");
    jpeg.response(1, true, Some("multipart/x-mixed-replace; boundary=frame"));
    // serve-sim starts sending the screen as it is, then the delivery stalls mid-picture.
    let before = part(&tiny());
    assert!(
        jpeg.chunk(1, &before[..20], 0.0)
            .iter()
            .all(|action| !matches!(action, Action::Frames(_)))
    );
    let (second, actions) = jpeg.replay().expect("asks meanwhile");
    assert_eq!(actions[0], Action::AwaitRequest { request: 1 });
    // The rest of the first picture belongs to the first still only.
    let rest = jpeg.chunk(1, &before[20..], 0.0);
    let drained = jpeg.step();
    assert_eq!(published(&rest).len() + published(&drained).len(), 1);
    let first_done = settled(&rest)
        .into_iter()
        .chain(settled(&drained))
        .collect::<Vec<_>>();
    assert!(first_done.contains(&(first, Ok(()))));
    assert!(
        !first_done.iter().any(|(still, _)| *still == second),
        "the stalled picture is not the screen after the action"
    );
    // The next picture is the screen after the action.
    let next = jpeg.chunk(1, &part(&tiny()), 0.0);
    let drained = jpeg.step();
    let all = settled(&next)
        .into_iter()
        .chain(settled(&drained))
        .collect::<Vec<_>>();
    assert!(all.contains(&(second, Ok(()))));
}

#[test]
fn stopping_cancels_a_request_serve_sim_has_not_answered() {
    let mut jpeg = idle();
    let (still, _) = jpeg.replay().expect("asks");
    let actions = jpeg.stop();
    assert!(actions.contains(&Action::AbortRequest { request: 1 }));
    assert_eq!(
        settled(&actions),
        vec![(still, Err(Reason::text("Simulator stream stopped")))]
    );
    // Nothing can be asked again.
    let (still, actions) = jpeg.replay().expect("asks");
    assert_eq!(
        settled(&actions),
        vec![(still, Err(Reason::text("Simulator stream stopped")))]
    );
}

#[test]
fn a_recording_keeps_the_stream_open_and_takes_every_picture_at_the_frame_interval() {
    let (mut jpeg, request) = started();
    let mut stream = part(&tiny());
    stream.extend(part(&tiny()));
    let first = jpeg.chunk(request, &stream, 0.0);
    assert!(published(&first).is_empty(), "the drain publishes later");
    let actions = jpeg.step();
    assert_eq!(published(&actions).len(), 1);
    assert!(first.iter().any(|action| matches!(
        action,
        Action::Frames(super::super::simulator_frames::Effect::Schedule { .. })
    )));
    let fired = jpeg.timer(34.0);
    assert!(fired.contains(&Action::Frames(
        super::super::simulator_frames::Effect::Drain
    )));
    let actions = jpeg.step();
    assert_eq!(
        published(&actions).len(),
        1,
        "the second waits its interval"
    );
    // Streaming never closes the request for want of stills.
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::AbortRequest { .. }))
    );
}

#[test]
fn a_response_that_cannot_be_read_fails_the_request_without_a_capture_failure() {
    let (mut jpeg, request) = started();
    assert_eq!(jpeg.chunk(request, b"nothing", 0.0), Vec::new());
    let mut fresh = SimulatorJpeg::new("http://127.0.0.1:1/stream", settings());
    let (request, _) = fresh.start();
    let actions = fresh.response(request, true, Some("text/plain"));
    assert_eq!(
        actions.last(),
        Some(&Action::RequestFailed {
            request,
            reason: Reason::text("Simulator framebuffer stream unavailable")
        })
    );
    assert!(actions.contains(&Action::AbortRequest { request }));
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::Failure(_)))
    );
    // A stream that ends on its own is the capture's failure.
    let (mut jpeg, request) = started();
    let actions = jpeg.ended(request);
    assert!(actions.contains(&Action::Failure(Reason::text(
        "Simulator framebuffer stream ended"
    ))));
}

#[test]
fn a_configure_while_streaming_forgets_the_old_picture_and_waits_for_the_new_request() {
    let mut jpeg = idle();
    let (still, actions) = jpeg.configure(settings(), false);
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::OpenRequest { request: 1, .. }))
    );
    let ready = jpeg.response(1, true, Some("multipart/x-mixed-replace; boundary=frame"));
    assert!(ready.contains(&Action::RequestReady { request: 1 }));
    let drained = jpeg.step();
    let all = settled(&ready)
        .into_iter()
        .chain(settled(&drained))
        .collect::<Vec<_>>();
    assert_eq!(
        all,
        vec![(still, Ok(()))],
        "no picture remembered to replay"
    );
}
