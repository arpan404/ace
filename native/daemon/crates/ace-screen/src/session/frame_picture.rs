// SPDX-License-Identifier: Apache-2.0

//! A captured frame as the shared media stream's picture kinds carry it (`frame-picture.ts`).

use std::ops::Range;
use std::sync::Arc;

use ace_json::JsString;

use super::frames::{Codec, Frame};

/// The codec a capture's H.264 is in when it doesn't say (Baseline, level 3.1)
/// (`frame-picture.ts:11`).
pub const DEFAULT_VIDEO_CODEC: &str = "avc1.42E01F";

/// A screen stream id's limit (`ScreenId` is at most 64 units).
const STREAM_ID_LIMIT: usize = 64;

/// A captured frame as a picture message carries it, and whether its codec string was given
/// (`frame-picture.ts:5`). The bytes are a view into the frame's packet: nothing is copied.
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedPicture {
    pub sequence: u64,
    pub timestamp: f64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub rotation: u16,
    pub codec: JsString,
    pub key: bool,
    pub codec_named: bool,
    pub stream_id: JsString,
    packet: Arc<[u8]>,
    payload: Range<usize>,
}

impl CapturedPicture {
    /// The encoded bytes, a view into the frame's packet.
    pub fn bytes(&self) -> &[u8] {
        &self.packet[self.payload.clone()]
    }
}

/// The stream id of a frame's capture (`frame-picture.ts:18`): a session that restarts its
/// capture under a new generation is a new stream, so a viewer starts it over at a keyframe.
fn stream_of(frame: &Frame) -> JsString {
    let session = &frame.header.session_id;
    let Some(generation) = frame.header.capture_generation else {
        return session.clone();
    };
    let suffix = format!("-g{generation}");
    let keep = STREAM_ID_LIMIT.saturating_sub(suffix.len());
    let units: Vec<u16> = session.units().take(keep).collect();
    let mut stream = JsString::from_units(&units);
    stream.push_str(&suffix);
    stream
}

/// A captured frame as the picture kinds carry it (`frame-picture.ts:27`).
pub fn frame_picture(frame: &Frame) -> CapturedPicture {
    let header = &frame.header;
    let jpeg = header.codec == Codec::Jpeg;
    let codec = if jpeg {
        JsString::from("jpeg")
    } else {
        header
            .video_codec
            .clone()
            .unwrap_or_else(|| JsString::from(DEFAULT_VIDEO_CODEC))
    };
    let start = frame.packet().len() - frame.payload().len();
    CapturedPicture {
        sequence: header.sequence,
        timestamp: header.timestamp,
        width: header.width,
        height: header.height,
        scale: header.scale.unwrap_or(1.0),
        rotation: header.rotation.unwrap_or(0),
        codec,
        key: jpeg || header.keyframe == Some(true),
        codec_named: !jpeg && header.video_codec.is_some(),
        stream_id: stream_of(frame),
        packet: Arc::from(frame.packet()),
        payload: start..frame.packet().len(),
    }
}

#[cfg(test)]
// The `frame-picture` cases, moved from TypeScript
// (`packages/screen/src/frame-picture.test.ts`): a restarted capture is a new stream (`:17`),
// and the helper's H.264 keeps its codec, keyframe flag, size and scale (`:28`).
mod tests {
    use super::frame_picture;
    use crate::session::frames::{Frame, FrameHeader, wire_frame};
    use ace_json::json;

    fn frame(header: &ace_json::Value) -> Frame {
        let mut value = json!({
            "version": 1,
            "sessionId": "session-1",
            "sequence": 4,
            "timestamp": 1000,
            "width": 1280,
            "height": 800,
            "codec": "jpeg",
            "bytes": 3,
        });
        if let (Some(target), Some(extra)) = (value.as_object_mut(), header.as_object()) {
            for (key, field) in extra {
                target.insert(key.clone(), field.clone());
            }
        }
        let parsed = FrameHeader::decode(&value).unwrap_or_else(|error| panic!("{error}"));
        wire_frame(parsed, &[1, 2, 3]).unwrap_or_else(|error| panic!("{error}"))
    }

    /// `frame-picture.test.ts:17`.
    #[test]
    fn a_restarted_capture_is_a_new_stream_so_a_viewer_starts_it_over_at_a_keyframe() {
        let first = frame_picture(&frame(&json!({ "captureGeneration": 1 })));
        let second = frame_picture(&frame(&json!({ "captureGeneration": 2 })));
        assert_ne!(first.stream_id, second.stream_id);
        assert_eq!(
            frame_picture(&frame(&json!({}))).stream_id.as_str(),
            "session-1"
        );
        // A session id at the limit still leaves room for the generation.
        let long = frame_picture(&frame(&json!({
            "sessionId": "s".repeat(64),
            "captureGeneration": 12,
        })));
        assert_eq!(long.stream_id.as_str().chars().count(), 64);
        assert!(long.stream_id.as_str().ends_with("-g12"));
    }

    /// `frame-picture.test.ts:28`.
    #[test]
    fn the_helpers_h264_keeps_its_codec_keyframe_flag_size_and_scale() {
        let key = frame_picture(&frame(&json!({
            "codec": "h264",
            "keyframe": true,
            "videoCodec": "avc1.640028",
            "scale": 2,
        })));
        assert_eq!(key.codec.as_str(), "avc1.640028");
        assert!(key.key);
        assert!(key.codec_named);
        assert_eq!(
            (key.width, key.height, key.scale, key.rotation),
            (1280, 800, 2.0, 0)
        );
        let delta = frame_picture(&frame(&json!({ "codec": "h264", "keyframe": false })));
        assert!(!delta.key);
        assert!(!delta.codec_named);
        assert_eq!(delta.codec.as_str(), "avc1.42E01F");
        // Every JPEG stands alone.
        assert!(frame_picture(&frame(&json!({}))).key);
    }
}
