// SPDX-License-Identifier: Apache-2.0
//! `media-paths.ts`'s egress side: one ace-media unit as the capture's own video unit, with the
//! producer stamp's capture time, the keyframe's own codec string and the encode's codec.

use crate::platform::scrcpy::video::VideoUnit;

/// A device's stream is H.264 whatever its producer.
pub const H264_ONLY: &str = "avc1.42E033";
const KEYFRAME: u32 = 1;

/// One frame as ace-media's egress carries it, read only for the fields a device unit needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressFrame {
    pub kind: u8,
    pub codec: u8,
    pub flags: u32,
    pub width: u32,
    pub height: u32,
    pub encode: u32,
    pub codec_string: String,
    pub extension: Vec<u8>,
    pub payload: Vec<u8>,
}

/// One egress unit: the path it came on and its frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressUnit {
    pub source: String,
    pub sequence: u64,
    pub frame: EgressFrame,
}

/// The producer's stamp as `readProducerStamp` reads it (docs/media/plan.md, "Producer stamp"):
/// a MediaFrame header extension, big endian, u16 tag 1, u16 length 24, u64 sequence, f64
/// capture time (Unix ms), f64 exact scale.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ProducerStamp {
    timestamp: f64,
}

fn read_producer_stamp(extension: &[u8]) -> Option<ProducerStamp> {
    let mut offset = 0usize;
    while offset + 4 <= extension.len() {
        let kind = u16::from_be_bytes([extension[offset], extension[offset + 1]]);
        let size = usize::from(u16::from_be_bytes([
            extension[offset + 2],
            extension[offset + 3],
        ]));
        let body = offset + 4;
        if body + size > extension.len() {
            return None;
        }
        if kind == 1 && size == 24 {
            let sequence = u64::from_be_bytes([
                extension[body],
                extension[body + 1],
                extension[body + 2],
                extension[body + 3],
                extension[body + 4],
                extension[body + 5],
                extension[body + 6],
                extension[body + 7],
            ]);
            if sequence > 9_007_199_254_740_991 {
                return None;
            }
            let timestamp = f64::from_be_bytes([
                extension[body + 8],
                extension[body + 9],
                extension[body + 10],
                extension[body + 11],
                extension[body + 12],
                extension[body + 13],
                extension[body + 14],
                extension[body + 15],
            ]);
            let scale = f64::from_be_bytes([
                extension[body + 16],
                extension[body + 17],
                extension[body + 18],
                extension[body + 19],
                extension[body + 20],
                extension[body + 21],
                extension[body + 22],
                extension[body + 23],
            ]);
            if !timestamp.is_finite() || !scale.is_finite() || scale <= 0.0 {
                return None;
            }
            return Some(ProducerStamp { timestamp });
        }
        offset = body + size;
    }
    None
}

/// An egress unit as the capture's own video unit, or `None` when it isn't H.264 video.
pub fn egress_video_unit(unit: &EgressUnit, codec: &str) -> Option<VideoUnit> {
    let frame = &unit.frame;
    if frame.kind != 1 || frame.codec != 1 || frame.width == 0 || frame.height == 0 {
        return None;
    }
    let stamp = read_producer_stamp(&frame.extension);
    let keyframe = frame.flags & KEYFRAME != 0;
    Some(VideoUnit {
        payload: frame.payload.clone(),
        keyframe,
        video_codec: if keyframe && !frame.codec_string.is_empty() {
            frame.codec_string.clone()
        } else {
            codec.to_string()
        },
        width: frame.width,
        height: frame.height,
        pts: ((stamp.map_or(0.0, |stamp| stamp.timestamp)) * 1000.0).round() as i64,
        encode: Some(frame.encode),
    })
}
