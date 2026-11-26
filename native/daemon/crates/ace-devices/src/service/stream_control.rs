// SPDX-License-Identifier: Apache-2.0
//! The device's stream rules (`packages/devices/src/stream-control.ts`): what an
//! unwatched capture streams, the JPEG refusal a live view gets, and the codec a
//! capture must reach while anyone watches.
//!
//! The owners' arbitration (`StreamOwners`, `commonStream`) is `@ace/screen`'s
//! (screen S-items), so the shell composes it with these rules rather than this
//! module re-implementing it.

use super::words;
use crate::error::DeviceError;

/// A live view's frame rate on every connection (`stream-profile.ts:9`).
pub const DEVICE_FRAME_RATE: u32 = 60;

/// What a capture encodes with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Jpeg,
    H264,
}

impl Codec {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::H264 => "h264",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Self::Jpeg),
            "h264" => Some(Self::H264),
            _ => None,
        }
    }
}

/// One capture's stream settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamSettings {
    pub codec: Codec,
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

/// A capture nobody is watching: agents' stills and recordings read its JPEG
/// frames. No live view ever receives one; a view's arrival switches to H.264.
pub const DEVICE_IMAGE_STREAM: StreamSettings = StreamSettings {
    codec: Codec::Jpeg,
    max_width: 1920,
    max_height: 2160,
    fps: 30,
    bitrate: 4_000_000,
};

/// A capture nobody watches or records, making a fresh still whenever an agent
/// asks for one and streaming nothing in between. The budget sizes each still.
pub const DEVICE_STILL_STREAM: StreamSettings = StreamSettings {
    fps: 2,
    ..DEVICE_IMAGE_STREAM
};

/// A recording nobody watches: H.264, which ace-media records as it comes. A
/// watched device records its viewers' video instead.
pub const DEVICE_RECORDING_STREAM: StreamSettings = StreamSettings {
    codec: Codec::H264,
    max_width: 1280,
    max_height: 2560,
    fps: 30,
    bitrate: 4_000_000,
};

/// A live view that hasn't sized its stream yet: H.264 at 60 fps in a
/// phone-sized box.
pub const DEVICE_VIDEO_STREAM: StreamSettings = StreamSettings {
    codec: Codec::H264,
    max_width: 1440,
    max_height: 2880,
    fps: DEVICE_FRAME_RATE,
    bitrate: 8_000_000,
};

/// `liveViewRequest`: a live view only takes video, so a client asking for JPEG
/// is out of date.
pub fn live_view_request(settings: StreamSettings) -> Result<StreamSettings, DeviceError> {
    if settings.codec != Codec::H264 {
        return Err(words::refusal("liveViewH264Only"));
    }
    Ok(settings)
}

/// The stream an idle capture takes: a recording's video while one runs, else the
/// caller's own idle choice.
pub fn idle_stream(recording: bool) -> StreamSettings {
    if recording {
        DEVICE_RECORDING_STREAM
    } else {
        DEVICE_IMAGE_STREAM
    }
}

/// The check after a capture applied new settings: a live view's H.264 must be
/// what the capture reached, never a downgrade to JPEG.
pub fn check_applied(next: Codec, applied: Codec) -> Result<(), DeviceError> {
    if next == Codec::H264 && applied != Codec::H264 {
        return Err(words::refusal("captureNoVideo"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
