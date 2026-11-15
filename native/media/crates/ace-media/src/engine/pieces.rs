// SPDX-License-Identifier: Apache-2.0
//! A unit as one viewer receives it (D1): ADR 0088's `ACES` envelope, with the header the
//! client already decodes on its main socket. Pure.
//!
//! - **Browser views** get `browserVideo` (kind 2) with the producer's bytes and description as
//!   they arrived, and `browserAudio` (kind 3) for Opus packets.
//! - **Screens and devices** get `screenFrame` (5) or `deviceFrame` (4): one access unit in
//!   Annex B with its parameter sets in front of every keyframe, as the main socket sends them.
//!   A length-prefixed H.264 unit is converted with its `avcC`.
use media_bitstream::avcc::AvcConfig;
use media_bitstream::nal::length_prefixed_to_annex_b;
use media_core::envelope::Pieces;
use media_core::headers::{Audio, Picture, Video};
use media_wire::control::ViewerTarget;
use media_wire::frame::MediaFrame;

pub const KIND_BROWSER_VIDEO: u8 = 2;
pub const KIND_BROWSER_AUDIO: u8 = 3;
pub const KIND_DEVICE_FRAME: u8 = 4;
pub const KIND_SCREEN_FRAME: u8 = 5;

/// `MediaFrame` kinds and codecs this module reads.
const FRAME_VIDEO: u8 = 1;
const FRAME_AUDIO: u8 = 2;
const CODEC_H264_AVCC: u8 = 2;
const CODEC_OPUS: u8 = 9;
const FLAG_KEY: u32 = 1;

/// When a unit was captured, in Unix ms: the producer stamp's exact time when it carries one
/// (header extension tag 1: u64 sequence, f64 capture time, f64 scale), else the wall clock less
/// the unit's age.
pub fn captured_ms(frame: &MediaFrame, wall_ms: u64) -> f64 {
    let mut rest = frame.extension.as_slice();
    while rest.len() >= 4 {
        let tag = u16::from_be_bytes([rest[0], rest[1]]);
        let length = usize::from(u16::from_be_bytes([rest[2], rest[3]]));
        let Some(value) = rest.get(4..4 + length) else {
            break;
        };
        if tag == 1 && length == 24 {
            let mut time = [0u8; 8];
            time.copy_from_slice(&value[8..16]);
            let at = f64::from_be_bytes(time);
            if at.is_finite() && at > 0.0 {
                return at;
            }
        }
        rest = &rest[4 + length..];
    }
    wall_ms as f64 - f64::from(frame.age_us) / 1000.0
}

/// What a unit becomes for one view: its pieces, each one binary WebSocket message.
pub struct Built {
    pub pieces: Vec<Vec<u8>>,
    pub key: bool,
    pub bytes: usize,
}

/// The stream id a screen or device view's pictures carry: one per source, so a new source
/// (a restart, a route change) starts over at a keyframe on the client.
pub fn stream_id(source: &str) -> String {
    source
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect()
}

fn cut(kind: u8, id: u32, meta: &[u8], payload: &[u8]) -> Option<Vec<Vec<u8>>> {
    let pieces = Pieces::new(kind, id, meta, payload).ok()?;
    let mut out = Vec::new();
    for piece in pieces {
        let mut bytes = vec![0; piece.len()];
        piece.write_to(&mut bytes).ok()?;
        out.push(bytes);
    }
    Some(out)
}

/// Annex B with parameter sets in front of a keyframe, for picture views.
fn annex_b(frame: &MediaFrame, key: bool) -> Option<Vec<u8>> {
    if frame.codec != CODEC_H264_AVCC {
        return Some(frame.payload.clone());
    }
    let config = AvcConfig::parse(&frame.description).ok();
    let length = config.as_ref().map_or(4, |c| usize::from(c.length_size));
    let mut body = Vec::with_capacity(frame.payload.len() + 64);
    length_prefixed_to_annex_b(&frame.payload, length, &mut body).ok()?;
    if !key {
        return Some(body);
    }
    let config = config?;
    let mut out = Vec::with_capacity(body.len() + 64);
    for set in config.sps.iter().chain(config.pps.iter()) {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(set);
    }
    out.extend_from_slice(&body);
    Some(out)
}

/// One unit's pieces for a view, or `None` for a unit it can't show (a picture codec the
/// header can't name, a malformed record).
pub fn build(
    target: &ViewerTarget,
    source: &str,
    message: u32,
    sequence: u64,
    timestamp_ms: f64,
    frame: &MediaFrame,
) -> Option<Built> {
    let key = frame.flags & FLAG_KEY != 0;
    let mut meta = vec![0u8; 512 + frame.description.len()];
    match (target, frame.kind) {
        (ViewerTarget::Browser { thread_id, tab_id }, FRAME_VIDEO) => {
            let header = Video {
                sequence: sequence as f64,
                timestamp: timestamp_ms,
                width: u32::from(frame.display_width.max(100)),
                height: u32::from(frame.display_height.max(100)),
                coded_width: frame.width,
                coded_height: frame.height,
                key,
                codec: &frame.codec_string,
                description: if key { &frame.description } else { &[] },
                thread_id: thread_id.get(),
                tab_id: tab_id.as_ref().map(|t| t.get()),
            };
            let n = header.encode(&mut meta).ok()?;
            let pieces = cut(KIND_BROWSER_VIDEO, message, &meta[..n], &frame.payload)?;
            Some(Built {
                pieces,
                key,
                bytes: n + frame.payload.len(),
            })
        }
        (ViewerTarget::Browser { thread_id, tab_id }, FRAME_AUDIO) if frame.codec == CODEC_OPUS => {
            let rate = frame
                .description
                .get(..4)
                .map_or(48_000, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
            let header = Audio {
                sequence: sequence as f64,
                timestamp: timestamp_ms,
                sample_rate: rate,
                channels: frame.description.get(4).copied().unwrap_or(2),
                codec: "opus",
                thread_id: thread_id.get(),
                tab_id: tab_id.as_ref().map(|t| t.get()),
            };
            let n = header.encode(&mut meta).ok()?;
            let pieces = cut(KIND_BROWSER_AUDIO, message, &meta[..n], &frame.payload)?;
            Some(Built {
                pieces,
                key: true,
                bytes: n + frame.payload.len(),
            })
        }
        (ViewerTarget::Screen { session_id: id }, FRAME_VIDEO)
        | (ViewerTarget::Device { device_id: id }, FRAME_VIDEO) => {
            let kind = match target {
                ViewerTarget::Screen { .. } => KIND_SCREEN_FRAME,
                _ => KIND_DEVICE_FRAME,
            };
            let payload = annex_b(frame, key)?;
            let stream = stream_id(source);
            let header = Picture {
                sequence: sequence as f64,
                timestamp: timestamp_ms.max(0.0),
                width: frame.width.max(1),
                height: frame.height.max(1),
                scale: f64::from(frame.scale.max(1)) / 1000.0,
                rotation: u16::from(frame.rotation % 4) * 90,
                key,
                still: false,
                codec: &frame.codec_string,
                source_id: id.get(),
                stream_id: &stream,
            };
            let n = header.encode(&mut meta).ok()?;
            let pieces = cut(kind, message, &meta[..n], &payload)?;
            Some(Built {
                pieces,
                key,
                bytes: n + payload.len(),
            })
        }
        _ => None,
    }
}
