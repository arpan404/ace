// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-capture.ts`'s decisions, before its sockets: whether a new profile is worth
//! restarting the server, the profile one run asks for, whether ace-media reads the video
//! socket itself, the display a frame of a size shows, the frame the daemon forwards, and the
//! capture's own errors. The sockets, processes, timers and ace-media are the shell's.

use serde::Serialize;

use crate::platform::media_paths::{VideoUnit, encode_producer_stamp};
use crate::platform::scrcpy::protocol::{self, ScreenSize, ServerProfile};
use crate::platform::{Code, Error, Failure};

/// Control bytes queued in the socket before input is refused rather than delayed.
pub const CONTROL_BACKLOG: usize = 256 * 1024;
/// A keyframe request restarts the device encoder; repeat one only when it went unanswered.
pub const KEYFRAME_RETRY_MS: f64 = 1_000.0;
/// How long ace-media gets for one scrcpy video handshake (D1): one startup deadline.
pub const MEDIA_STARTUP_MS: u64 = 10_000;

/// The parts of a stream's settings a scrcpy run is sized by.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureSettings {
    pub max_width: f64,
    pub max_height: f64,
    pub fps: f64,
    pub bitrate: f64,
}

/// One frame as the daemon forwards it to viewers (`scrcpyFrame`): the producer stamp keeps
/// its sequence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MediaFrame {
    pub kind: u8,
    pub flags: u32,
    #[serde(rename = "ageUs")]
    pub age_us: u64,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "displayWidth")]
    pub display_width: u32,
    #[serde(rename = "displayHeight")]
    pub display_height: u32,
    /// Thousandths, as the media protocol spells a scale.
    pub scale: u32,
    pub rotation: u16,
    pub codec: u8,
    pub encode: u32,
    pub epoch: u64,
    #[serde(rename = "codecString")]
    pub codec_string: String,
    pub description: Vec<u8>,
    pub extension: Vec<u8>,
    pub payload: Vec<u8>,
}

/// Whether a new profile is worth restarting the server, which costs a second or more without
/// a picture. A new size or frame rate always is. A bit rate alone (a viewer's link moving) is
/// only when it changes by half or more and the server has run for 10 s, so a link that wavers
/// never keeps the view restarting.
pub fn restart_worth_it(current: &ServerProfile, wanted: &ServerProfile, running_ms: f64) -> bool {
    if current.max_size != wanted.max_size || current.fps != wanted.fps {
        return true;
    }
    if current.bitrate == wanted.bitrate {
        return false;
    }
    let ratio = current.bitrate.max(wanted.bitrate) / current.bitrate.min(wanted.bitrate);
    ratio >= 1.5 && running_ms >= 10_000.0
}

/// The profile one run asks for, sized by the transport's display and the stream's settings.
pub fn profile_for(settings: CaptureSettings, display: ScreenSize, scid: u32) -> ServerProfile {
    ServerProfile {
        scid,
        max_size: protocol::max_size(display, settings.max_width, settings.max_height) as f64,
        bitrate: settings.bitrate,
        fps: settings.fps,
        video: true,
    }
}

/// D1: whether ace-media reads a run's video socket itself.
pub fn media_video(profile: &ServerProfile, backend_native: bool) -> bool {
    profile.video && backend_native
}

/// The display in the orientation of a frame of this size.
pub fn display_for(long_edge: f64, short_edge: f64, width: f64, height: f64) -> ScreenSize {
    if width >= height {
        ScreenSize {
            width: long_edge,
            height: short_edge,
        }
    } else {
        ScreenSize {
            width: short_edge,
            height: long_edge,
        }
    }
}

/// A scrcpy unit as the frame the daemon forwards: the picture's own size and the display's,
/// the keyframe's codec, and the producer stamp that keeps its sequence and capture time.
pub fn frame(unit: &VideoUnit, display: ScreenSize, sequence: u64) -> MediaFrame {
    let timestamp = unit.pts as f64 / 1000.0;
    MediaFrame {
        kind: 1,
        flags: if unit.keyframe { 1 } else { 0 },
        age_us: 0,
        width: unit.width,
        height: unit.height,
        display_width: display.width as u32,
        display_height: display.height as u32,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode: 0,
        epoch: 0,
        codec_string: if unit.keyframe {
            unit.video_codec.clone()
        } else {
            String::new()
        },
        description: Vec::new(),
        extension: encode_producer_stamp(sequence, timestamp, 1.0),
        payload: unit.payload.clone(),
    }
}

/// Why there is no control link: a restart in progress, or a capture that has ended.
pub fn unavailable(stopped: bool) -> Error {
    if stopped {
        command_failed(
            "The Android screen stream ended",
            "Start the device view again.",
        )
    } else {
        busy("Android control is reconnecting", "Retry the action.")
    }
}

pub fn input_backlog() -> Error {
    busy("Android input backlog exceeded limit", "Retry the action.")
}

pub fn screen_ended() -> Error {
    command_failed(
        "The Android screen stream ended",
        "Start the device view again.",
    )
}

pub fn server_stopped() -> Error {
    command_failed(
        "scrcpy-server stopped on the device",
        "Start the device view again.",
    )
}

pub fn control_restarted() -> Error {
    busy("Android control restarted", "Retry.")
}

pub fn screen_not_started() -> Error {
    busy("The Android screen has not started yet", "Retry shortly.")
}

pub fn capture_stopped() -> Error {
    busy("Device capture has stopped", "Start it again.")
}

pub fn media_needed() -> Error {
    command_failed(
        "The Android live view needs ace-media",
        "Restart ace to bring ace-media back.",
    )
}

fn command_failed(message: &str, hint: &str) -> Error {
    failed(Code::CommandFailed, message, hint)
}

fn busy(message: &str, hint: &str) -> Error {
    failed(Code::Busy, message, hint)
}

fn failed(code: Code, message: &str, hint: &str) -> Error {
    Error::Failed(Failure {
        code,
        message: message.to_string(),
        hint: hint.to_string(),
    })
}

#[cfg(test)]
mod tests;
