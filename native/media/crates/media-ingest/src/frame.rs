// SPDX-License-Identifier: Apache-2.0
//! MediaFrame v1 framing for a producer's units, through `media-wire` (docs/media/plan.md,
//! "Ingest framing" and "Producer stamp").
use media_wire::frame::MediaFrame;
use zeroize::{Zeroize, Zeroizing};

pub const KIND_VIDEO: u8 = 1;
pub const KIND_END: u8 = 4;
pub const KIND_HELLO: u8 = 5;
pub const CODEC_H264_ANNEXB: u8 = 1;
pub const FLAG_KEYFRAME: u32 = 1;
pub const TOKEN_LEN: usize = 32;

/// One encoded picture, with what both paths need to describe it.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoUnit {
    /// The helper's frame sequence, shared with its stills.
    pub sequence: u64,
    /// When the picture was captured, Unix milliseconds.
    pub timestamp_ms: f64,
    /// Output pixels per logical point.
    pub scale: f64,
    pub width: u32,
    pub height: u32,
    pub key: bool,
    /// The WebCodecs codec string, on keyframes.
    pub codec: Option<String>,
    /// The privacy epoch held when the picture was captured.
    pub epoch: u32,
    /// The capture time on the helper's monotonic clock, microseconds, for the unit's age.
    pub captured_us: u64,
    /// H.264 Annex B, parameter sets before every IDR.
    pub payload: Vec<u8>,
}

/// Tag 1, length 24: sequence (u64), capture time (f64 Unix ms), scale (f64), big endian.
pub fn producer_stamp(sequence: u64, timestamp_ms: f64, scale: f64) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(28);
    bytes.extend_from_slice(&1u16.to_be_bytes());
    bytes.extend_from_slice(&24u16.to_be_bytes());
    bytes.extend_from_slice(&sequence.to_be_bytes());
    bytes.extend_from_slice(&timestamp_ms.to_bits().to_be_bytes());
    bytes.extend_from_slice(&scale.to_bits().to_be_bytes());
    bytes
}

fn empty(kind: u8) -> MediaFrame {
    MediaFrame {
        kind,
        flags: 0,
        age_us: 0,
        width: 0,
        height: 0,
        display_width: 0,
        display_height: 0,
        scale: 1000,
        rotation: 0,
        codec: 0,
        encode: 0,
        epoch: 0,
        codec_string: String::new(),
        description: vec![],
        extension: vec![],
        payload: vec![],
    }
}

/// One unit as a MediaFrame; `None` when it can't be framed (too large, a bad size or scale).
pub fn video_frame(unit: &VideoUnit, now_us: u64) -> Option<Vec<u8>> {
    let width = u16::try_from(unit.width).ok().filter(|w| *w > 0)?;
    let height = u16::try_from(unit.height).ok().filter(|h| *h > 0)?;
    if !unit.scale.is_finite() || unit.scale <= 0.0 || unit.payload.is_empty() {
        return None;
    }
    let display = |pixels: u16| {
        (f64::from(pixels) / unit.scale)
            .round()
            .clamp(1.0, 65_535.0) as u16
    };
    let frame = MediaFrame {
        flags: if unit.key { FLAG_KEYFRAME } else { 0 },
        age_us: u32::try_from(now_us.saturating_sub(unit.captured_us)).unwrap_or(u32::MAX),
        width,
        height,
        display_width: display(width),
        display_height: display(height),
        scale: (unit.scale * 1000.0).round().clamp(1.0, 65_535.0) as u16,
        codec: CODEC_H264_ANNEXB,
        epoch: unit.epoch,
        codec_string: if unit.key {
            unit.codec.clone().unwrap_or_default()
        } else {
            String::new()
        },
        extension: producer_stamp(unit.sequence, unit.timestamp_ms, unit.scale),
        payload: unit.payload.clone(),
        ..empty(KIND_VIDEO)
    };
    frame.encode().ok()
}

/// The connection's first frame: its payload is the source's single-use token. Both the
/// frame and its copy of the token are wiped when dropped.
pub fn hello(token: &[u8; TOKEN_LEN]) -> Zeroizing<Vec<u8>> {
    let mut frame = empty(KIND_HELLO);
    frame.payload = token.to_vec();
    let bytes = Zeroizing::new(frame.encode().unwrap_or_default());
    frame.payload.zeroize();
    bytes
}

/// The end of a path: written after its last unit, so ace-media ends it cleanly.
pub fn end() -> Vec<u8> {
    empty(KIND_END).encode().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(key: bool) -> VideoUnit {
        VideoUnit {
            sequence: 41,
            timestamp_ms: 1_700_000_000_123.5,
            scale: 1.5,
            width: 1920,
            height: 1080,
            key,
            codec: Some("avc1.42C028".into()),
            epoch: 7,
            captured_us: 1_000,
            payload: vec![0, 0, 0, 1, 0x65, 1, 2, 3],
        }
    }

    #[test]
    fn a_unit_decodes_as_the_frame_ace_media_expects_with_its_stamp() {
        let bytes = video_frame(&unit(true), 4_500).unwrap();
        let frame = MediaFrame::decode(&bytes).unwrap();
        assert_eq!(
            (frame.kind, frame.codec, frame.flags),
            (KIND_VIDEO, CODEC_H264_ANNEXB, FLAG_KEYFRAME)
        );
        assert_eq!((frame.width, frame.height), (1920, 1080));
        assert_eq!((frame.display_width, frame.display_height), (1280, 720));
        assert_eq!((frame.scale, frame.epoch, frame.age_us), (1500, 7, 3_500));
        assert_eq!(frame.codec_string, "avc1.42C028");
        assert_eq!(frame.payload, unit(true).payload);
        // The producer stamp the daemon rebuilds its header from.
        let stamp = &frame.extension;
        assert_eq!(&stamp[..4], &[0, 1, 0, 24]);
        assert_eq!(u64::from_be_bytes(stamp[4..12].try_into().unwrap()), 41);
        assert_eq!(
            f64::from_bits(u64::from_be_bytes(stamp[12..20].try_into().unwrap())),
            1_700_000_000_123.5
        );
        assert_eq!(
            f64::from_bits(u64::from_be_bytes(stamp[20..28].try_into().unwrap())),
            1.5
        );
    }

    #[test]
    fn deltas_carry_no_codec_string_and_no_keyframe_flag() {
        let frame = MediaFrame::decode(&video_frame(&unit(false), 0).unwrap()).unwrap();
        assert_eq!((frame.flags, frame.codec_string.as_str()), (0, ""));
    }

    #[test]
    fn units_that_cannot_be_framed_are_refused() {
        for broken in [
            VideoUnit {
                width: 70_000,
                ..unit(true)
            },
            VideoUnit {
                scale: 0.0,
                ..unit(true)
            },
            VideoUnit {
                payload: vec![],
                ..unit(true)
            },
            VideoUnit {
                payload: vec![0; 9 * 1024 * 1024],
                ..unit(true)
            },
        ] {
            assert_eq!(video_frame(&broken, 0), None);
        }
    }

    #[test]
    fn hello_carries_the_token_and_end_is_a_bare_end_frame() {
        let hello = MediaFrame::decode(&hello(&[9; 32])).unwrap();
        assert_eq!((hello.kind, hello.payload), (KIND_HELLO, vec![9; 32]));
        let end = MediaFrame::decode(&end()).unwrap();
        assert_eq!((end.kind, end.payload.len()), (KIND_END, 0));
    }
}
