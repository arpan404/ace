// SPDX-License-Identifier: Apache-2.0
//! `host-frames.ts`'s decisions: the shared picture file an emulator writes its RGBA screen
//! into, the square the gRPC screenshot stream is asked for, the note each new picture sends to
//! the host encoder, and the failure before or after the first picture. The gRPC stream, file
//! handle, encoder process and timers are the shell's.

use crate::platform::{Code, Error, Failure};

/// How long the first picture may take before the picture is left to scrcpy.
pub const STARTUP_MS: u64 = 5_000;
/// The smallest edge the screenshot stream is asked for.
pub const MIN_EDGE: f64 = 64.0;

/// The shared file's name in ace's tools directory.
pub fn file_name(runtime_id: &str) -> String {
    format!("emulator-frames-{runtime_id}.rgba")
}

/// The file's size: one RGBA picture of the display's own size.
pub fn file_bytes(width: u64, height: u64) -> u64 {
    width.saturating_mul(height).saturating_mul(4)
}

/// The square edge the screenshot stream asks for: the box, rounded, never below 64.
pub fn stream_edge(box_: f64) -> u32 {
    let rounded = box_.round();
    let edge = rounded.max(MIN_EDGE);
    if edge <= 0.0 {
        MIN_EDGE as u32
    } else {
        edge as u32
    }
}

/// One new picture's note to the host encoder: its sequence, size and capture time in ms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PictureNote {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub ts: f64,
}

/// A notice as the note the encoder reads, or `None` for a display that is off.
pub fn picture_note(seq: u64, width: u32, height: u32, timestamp_us: f64) -> Option<PictureNote> {
    if width == 0 || height == 0 {
        return None;
    }
    Some(PictureNote {
        seq,
        width,
        height,
        ts: timestamp_us / 1000.0,
    })
}

/// A failure before the first picture rejects the wait; after it, the capture reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureRoute {
    RejectReady,
    Report,
}

pub fn failure_route(started: bool) -> FailureRoute {
    if started {
        FailureRoute::Report
    } else {
        FailureRoute::RejectReady
    }
}

/// A display that never shows a picture, a refused token or a missing encoder: not this way.
pub fn no_picture() -> Error {
    Error::Failed(Failure {
        code: Code::Timeout,
        message: "The emulator sent no picture".to_string(),
        hint: "Start the device view again.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_file_is_one_rgba_picture_of_the_display_size() {
        assert_eq!(file_name("abc"), "emulator-frames-abc.rgba");
        assert_eq!(file_bytes(1080, 2400), 1080 * 2400 * 4);
    }

    #[test]
    fn the_screenshot_square_is_the_box_rounded_and_never_below_64() {
        assert_eq!(stream_edge(1080.0), 1080);
        assert_eq!(stream_edge(63.0), 64);
        assert_eq!(stream_edge(63.6), 64);
        assert_eq!(stream_edge(64.4), 64);
        assert_eq!(stream_edge(64.6), 65);
        assert_eq!(stream_edge(0.0), 64);
    }

    #[test]
    fn a_lit_display_sends_a_note_with_its_time_in_milliseconds() {
        assert_eq!(
            picture_note(7, 1080, 2400, 1_500_000.0),
            Some(PictureNote {
                seq: 7,
                width: 1080,
                height: 2400,
                ts: 1_500.0
            })
        );
        assert_eq!(picture_note(7, 0, 2400, 0.0), None);
        assert_eq!(picture_note(7, 1080, 0, 0.0), None);
    }

    #[test]
    fn a_failure_before_the_first_picture_rejects_the_wait_and_after_it_is_reported() {
        assert_eq!(failure_route(false), FailureRoute::RejectReady);
        assert_eq!(failure_route(true), FailureRoute::Report);
        match no_picture() {
            Error::Failed(failure) => {
                assert_eq!(failure.code, Code::Timeout);
                assert_eq!(failure.message, "The emulator sent no picture");
                assert_eq!(failure.hint, "Start the device view again.");
            }
            other => panic!("unexpected: {other}"),
        }
    }
}
