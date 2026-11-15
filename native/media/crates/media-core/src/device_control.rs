// SPDX-License-Identifier: Apache-2.0
//! Shared device encode budget, independent of native reconfiguration I/O.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Jpeg,
    H264,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamSettings {
    pub codec: Codec,
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub bitrate: u32,
}
pub const IMAGE_STREAM: StreamSettings = StreamSettings {
    codec: Codec::Jpeg,
    max_width: 1920,
    max_height: 2160,
    fps: 30,
    bitrate: 4_000_000,
};
pub const STILL_STREAM: StreamSettings = StreamSettings {
    fps: 2,
    ..IMAGE_STREAM
};
pub const VIDEO_STREAM: StreamSettings = StreamSettings {
    codec: Codec::H264,
    max_width: 1440,
    max_height: 2880,
    fps: 60,
    bitrate: 8_000_000,
};
pub fn common_device_stream(profiles: &[StreamSettings]) -> StreamSettings {
    let Some(first) = profiles.first() else {
        return IMAGE_STREAM;
    };
    profiles.iter().fold(
        StreamSettings {
            codec: Codec::H264,
            ..*first
        },
        |a, b| StreamSettings {
            codec: Codec::H264,
            max_width: a.max_width.min(b.max_width),
            max_height: a.max_height.min(b.max_height),
            fps: a.fps.min(b.fps),
            bitrate: a.bitrate.min(b.bitrate),
        },
    )
}
pub fn live_view_request(settings: StreamSettings) -> Option<StreamSettings> {
    (settings.codec == Codec::H264).then_some(settings)
}
