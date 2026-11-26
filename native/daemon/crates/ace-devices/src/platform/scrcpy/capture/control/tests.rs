// SPDX-License-Identifier: Apache-2.0
//! Control dispatch: the keyframe retry window, the socket's backlog refusal, and the input
//! step's kind.

use super::*;
use crate::platform::Code;

#[test]
fn a_keyframe_is_asked_for_once_per_second_and_not_before_the_stream_starts() {
    let mut asker = KeyframeAsker::new();
    assert_eq!(asker.step(1_000.0, false, false), KeyframeStep::Skip);
    assert_eq!(asker.step(1_000.0, true, false), KeyframeStep::ResetVideo);
    assert_eq!(asker.step(1_500.0, true, false), KeyframeStep::Skip);
    assert_eq!(asker.step(2_000.0, true, true), KeyframeStep::Host);
    asker.delivered();
    assert_eq!(asker.last_asked(), f64::NEG_INFINITY);
    assert_eq!(asker.step(2_001.0, true, true), KeyframeStep::Host);
}

#[test]
fn a_backed_up_socket_refuses_input_and_a_missing_one_says_why() {
    assert!(writable(true, 0, false).is_ok());
    assert!(writable(true, CONTROL_BACKLOG, false).is_ok());
    match writable(true, CONTROL_BACKLOG + 1, false) {
        Err(Error::Failed(failure)) => {
            assert_eq!(failure.code, Code::Busy);
            assert_eq!(failure.message, "Android input backlog exceeded limit");
        }
        other => panic!("unexpected: {other:?}"),
    }
    match writable(false, 0, true) {
        Err(Error::Failed(failure)) => {
            assert_eq!(failure.code, Code::CommandFailed);
            assert_eq!(failure.message, "The Android screen stream ended");
        }
        other => panic!("unexpected: {other:?}"),
    }
    match writable(false, 0, false) {
        Err(Error::Failed(failure)) => {
            assert_eq!(failure.message, "Android control is reconnecting")
        }
        other => panic!("unexpected: {other:?}"),
    }
}

#[test]
fn a_clipboard_step_goes_through_the_clipboard_and_the_rest_to_the_socket() {
    assert_eq!(input_step(true), InputStep::Clipboard);
    assert_eq!(input_step(false), InputStep::Send);
}
