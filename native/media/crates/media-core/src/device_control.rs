// SPDX-License-Identifier: Apache-2.0
//! Shared device encode budget, independent of native reconfiguration I/O.
use crate::link_rate::LINK_FLOOR;
use crate::scale::Step;
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
/// A view's stream held to what its link carries, matching link-follow.ts: the bit rate capped
/// to the link, and the frame rate and size at the link's step, never above what was asked.
pub fn link_capped(asked: StreamSettings, rate: Option<f64>, step: Option<Step>) -> StreamSettings {
    let Some(rate) = rate.filter(|_| asked.codec == Codec::H264) else {
        return asked;
    };
    let step = step.unwrap_or(Step {
        scale: 1.0,
        fps: f64::from(asked.fps),
    });
    let unit = if rate < 1_000_000.0 {
        50_000.0
    } else {
        250_000.0
    };
    let carried = LINK_FLOOR.max((rate / unit).floor() * unit);
    let side = |side: u32| {
        let scaled = ((f64::from(side) * step.scale / 64.0).ceil() * 64.0).max(64.0);
        side.min(scaled as u32)
    };
    StreamSettings {
        max_width: side(asked.max_width),
        max_height: side(asked.max_height),
        fps: asked.fps.min(step.fps as u32),
        bitrate: asked.bitrate.min(carried as u32),
        ..asked
    }
}
