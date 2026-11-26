// SPDX-License-Identifier: Apache-2.0

//! Frames inside the daemon (`frames.ts`): a native screen helper writes each captured frame to
//! its pipe as `u32 header length | JSON ScreenFrameHeader | payload`, and a recording file is
//! the same frames back to back. A v2 header's short names (`seq`, `ts`) read as the v1 header
//! the daemon works with, and a field this port does not name stays in the header it carries.

use std::ops::Range;
use std::sync::Arc;

use ace_json::{JsString, Value, json};

use crate::error::ScreenError;

/// A header's JSON may not pass this many bytes (`frames.ts:23`).
pub const HEADER_LIMIT: usize = 4_096;
/// A frame's payload may not pass eight megabytes (`ScreenLegacyFrameHeader.bytes`).
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
/// The largest safe JavaScript integer (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The frame's codec (`codec: z.enum(["jpeg", "h264"])`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Jpeg,
    H264,
}

/// One dirty rectangle (`ScreenRect`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DirtyRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A frame's header, as `ScreenFrameHeader` validates it and a v1 `ScreenLegacyFrameHeader`
/// names it (`frames.ts:11`-`:21`). `raw` is the header as it came: fields this view does not
/// name survive, and a packet is written from it, never from a re-shaped object.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameHeader {
    pub session_id: JsString,
    pub sequence: u64,
    pub timestamp: f64,
    pub width: u32,
    pub height: u32,
    pub codec: Codec,
    pub keyframe: Option<bool>,
    pub video_codec: Option<JsString>,
    /// The helper's scale, when it named one.
    pub scale: Option<f64>,
    pub capture_generation: Option<u64>,
    pub dirty_rects: Option<Vec<DirtyRect>>,
    /// Degrees clockwise a viewer turns the picture to show it upright.
    pub rotation: Option<u16>,
    pub bytes: usize,
    raw: Value,
}

impl FrameHeader {
    /// The header as the pipe carried it, unknown fields included.
    pub fn raw(&self) -> &Value {
        &self.raw
    }

    /// Parse one header, v1 or v2 (`ScreenFrameHeader`): every field the schema requires must be
    /// there and in range; an unknown version or a malformed field is not a frame.
    pub fn decode(value: &Value) -> Result<FrameHeader, ScreenError> {
        let object = value.as_object().ok_or(ScreenError::InvalidHeader)?;
        let version = integer(object.get("version")).ok_or(ScreenError::InvalidHeader)?;
        if version != 1 && version != 2 {
            return Err(ScreenError::InvalidHeader);
        }
        let session_id = object
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))
            .map(JsString::from)
            .ok_or(ScreenError::InvalidHeader)?;
        let (sequence, timestamp) = if version == 2 {
            (
                object.get("seq").and_then(safe_integer),
                finite(object.get("ts")),
            )
        } else {
            (
                object.get("sequence").and_then(safe_integer),
                finite(object.get("timestamp")),
            )
        };
        let sequence = sequence.ok_or(ScreenError::InvalidHeader)?;
        let timestamp = timestamp
            .filter(|value| *value >= 0.0)
            .ok_or(ScreenError::InvalidHeader)?;
        let width = dimension(object.get("width")).ok_or(ScreenError::InvalidHeader)?;
        let height = dimension(object.get("height")).ok_or(ScreenError::InvalidHeader)?;
        let codec = match object.get("codec").and_then(Value::as_str) {
            Some("jpeg") => Codec::Jpeg,
            Some("h264") => Codec::H264,
            _ => return Err(ScreenError::InvalidHeader),
        };
        let scale = match object.get("scale") {
            Some(Value::Null) | None => {
                if version == 2 {
                    return Err(ScreenError::InvalidHeader);
                }
                None
            }
            Some(value) => {
                let scale = value
                    .as_f64()
                    .filter(|scale| scale.is_finite() && *scale > 0.0);
                let scale = match scale {
                    Some(scale) if version == 2 => Some(scale).filter(|scale| *scale <= 8.0),
                    other => other,
                };
                Some(scale.ok_or(ScreenError::InvalidHeader)?)
            }
        };
        let bytes = object
            .get("bytes")
            .and_then(safe_integer)
            .filter(|bytes| *bytes > 0.0 && *bytes as usize <= MAX_PAYLOAD_BYTES)
            .ok_or(ScreenError::InvalidHeader)? as usize;
        let keyframe = match object.get("keyframe") {
            Some(Value::Bool(value)) => Some(*value),
            Some(Value::Null) | None => None,
            Some(_) => return Err(ScreenError::InvalidHeader),
        };
        let video_codec = match object.get("videoCodec") {
            Some(Value::Null) | None => None,
            Some(Value::String(codec)) if valid_video_codec(codec.as_str()) => Some(codec.clone()),
            Some(_) => return Err(ScreenError::InvalidHeader),
        };
        let capture_generation = match object.get("captureGeneration") {
            Some(Value::Null) | None => None,
            Some(value) => Some(
                value
                    .as_f64()
                    .filter(|generation| {
                        *generation > 0.0
                            && generation.fract() == 0.0
                            && *generation <= MAX_SAFE_INTEGER
                    })
                    .ok_or(ScreenError::InvalidHeader)? as u64,
            ),
        };
        let dirty_rects = match object.get("dirtyRects") {
            Some(Value::Null) | None => None,
            Some(Value::Array(rects)) => {
                if rects.len() > 64 {
                    return Err(ScreenError::InvalidHeader);
                }
                let mut kept = Vec::with_capacity(rects.len());
                for rect in rects.iter() {
                    kept.push(rect_of(rect).ok_or(ScreenError::InvalidHeader)?);
                }
                Some(kept)
            }
            Some(_) => return Err(ScreenError::InvalidHeader),
        };
        let rotation = match object.get("rotation") {
            Some(Value::Null) | None => None,
            Some(value) => {
                let degrees = value
                    .as_f64()
                    .filter(|degrees| degrees.fract() == 0.0)
                    .map(|degrees| degrees as i64);
                match degrees {
                    Some(0) => Some(0),
                    Some(90) => Some(90),
                    Some(180) => Some(180),
                    Some(270) => Some(270),
                    _ => return Err(ScreenError::InvalidHeader),
                }
            }
        };
        Ok(FrameHeader {
            session_id,
            sequence: sequence as u64,
            timestamp,
            width,
            height,
            codec,
            keyframe,
            video_codec,
            scale,
            capture_generation,
            dirty_rects,
            rotation,
            bytes,
            raw: value.clone(),
        })
    }

    /// A one-frame v1 header, for fixtures and recordings (`testing/support.frame`).
    pub fn v1(session_id: &str, sequence: u64, bytes: usize) -> FrameHeader {
        FrameHeader {
            session_id: JsString::from(session_id),
            sequence,
            timestamp: 1000.0,
            width: 100,
            height: 100,
            codec: Codec::Jpeg,
            keyframe: None,
            video_codec: None,
            scale: None,
            capture_generation: None,
            dirty_rects: None,
            rotation: None,
            bytes,
            raw: json!({
                "version": 1,
                "sessionId": session_id,
                "sequence": sequence,
                "timestamp": 1000,
                "width": 100,
                "height": 100,
                "codec": "jpeg",
                "bytes": bytes,
            }),
        }
    }
}

/// One frame: its header, the packet as the pipe carried it, and the payload as a view into it
/// (`frames.ts:11`). One allocation per packet; no copy of the payload.
#[derive(Debug, Clone)]
pub struct Frame {
    pub header: FrameHeader,
    packet: Arc<[u8]>,
    payload: Range<usize>,
}

impl Frame {
    /// The frame as the helper pipe and recording files carry it.
    pub fn packet(&self) -> &[u8] {
        &self.packet
    }

    /// The encoded bytes (JPEG or H.264), a view into the packet.
    pub fn payload(&self) -> &[u8] {
        &self.packet[self.payload.clone()]
    }
}

/// One frame in the helper pipe's framing (`frames.ts:26`): `u32 length | JSON | payload`.
pub fn frame_packet(header: &FrameHeader, payload: &[u8]) -> Result<Vec<u8>, ScreenError> {
    let json = header.raw().to_json();
    if payload.len() != header.bytes || json.len() > HEADER_LIMIT {
        return Err(ScreenError::InvalidFrameSize);
    }
    let mut packet = Vec::with_capacity(4 + json.len() + payload.len());
    packet.extend_from_slice(&(json.len() as u32).to_be_bytes());
    packet.extend_from_slice(json.as_bytes());
    packet.extend_from_slice(payload);
    Ok(packet)
}

/// A frame as if it had come off the helper pipe: one packet, its payload a view into it
/// (`frames.ts:38`).
pub fn wire_frame(header: FrameHeader, payload: &[u8]) -> Result<Frame, ScreenError> {
    let packet = frame_packet(&header, payload)?;
    let payload_start = packet.len() - payload.len();
    Ok(Frame {
        header,
        payload: payload_start..packet.len(),
        packet: Arc::from(packet.into_boxed_slice()),
    })
}

/// Reads a helper pipe (or a recording) in chunks of any size (`frames.ts:74`). Each frame's
/// packet is one allocation; a frame is handed over as soon as its payload is complete.
pub struct FrameDecoder {
    length: [u8; 4],
    length_offset: usize,
    header_json: Vec<u8>,
    header_offset: usize,
    phase: Phase,
    header: Option<FrameHeader>,
    packet: Vec<u8>,
    /// Where the next payload byte goes in `packet`.
    payload_at: usize,
}

enum Phase {
    Length,
    Header,
    Payload,
}

impl FrameDecoder {
    pub fn new() -> FrameDecoder {
        FrameDecoder {
            length: [0; 4],
            length_offset: 0,
            header_json: Vec::new(),
            header_offset: 0,
            phase: Phase::Length,
            header: None,
            packet: Vec::new(),
            payload_at: 0,
        }
    }

    /// Read `chunk`, handing every complete frame to `emit` (`frames.ts:85`).
    pub fn push(&mut self, chunk: &[u8], emit: &mut dyn FnMut(Frame)) -> Result<(), ScreenError> {
        let mut position = 0;
        while position < chunk.len() {
            match self.phase {
                Phase::Length => {
                    let count = (4 - self.length_offset).min(chunk.len() - position);
                    self.length[self.length_offset..self.length_offset + count]
                        .copy_from_slice(&chunk[position..position + count]);
                    self.length_offset += count;
                    position += count;
                    if self.length_offset == 4 {
                        let length = u32::from_be_bytes(self.length) as usize;
                        if length == 0 || length > HEADER_LIMIT {
                            return Err(ScreenError::HeaderExceedsLimit);
                        }
                        self.header_json = vec![0; length];
                        self.header_offset = 0;
                        self.length_offset = 0;
                        self.phase = Phase::Header;
                    }
                }
                Phase::Header => {
                    let count =
                        (self.header_json.len() - self.header_offset).min(chunk.len() - position);
                    self.header_json[self.header_offset..self.header_offset + count]
                        .copy_from_slice(&chunk[position..position + count]);
                    self.header_offset += count;
                    position += count;
                    if self.header_offset == self.header_json.len() {
                        let text = std::str::from_utf8(&self.header_json)
                            .map_err(|_| ScreenError::InvalidHeader)?;
                        let value =
                            ace_json::parse(text).map_err(|_| ScreenError::InvalidHeader)?;
                        let header = FrameHeader::decode(&value)?;
                        let prefix = std::mem::take(&mut self.header_json);
                        self.packet = vec![0; 4 + prefix.len() + header.bytes];
                        self.packet[..4].copy_from_slice(&(prefix.len() as u32).to_be_bytes());
                        self.packet[4..4 + prefix.len()].copy_from_slice(&prefix);
                        self.payload_at = 4 + prefix.len();
                        self.header = Some(header);
                        self.phase = Phase::Payload;
                    }
                }
                Phase::Payload => {
                    let count = (self.packet.len() - self.payload_at).min(chunk.len() - position);
                    self.packet[self.payload_at..self.payload_at + count]
                        .copy_from_slice(&chunk[position..position + count]);
                    self.payload_at += count;
                    position += count;
                    if self.payload_at == self.packet.len() {
                        let packet = std::mem::take(&mut self.packet);
                        let header = self.header.take().ok_or(ScreenError::MissingHeader)?;
                        let payload = (packet.len() - header.bytes)..packet.len();
                        self.reset();
                        emit(Frame {
                            header,
                            payload,
                            packet: Arc::from(packet.into_boxed_slice()),
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// The stream ended: a frame cut short is a failure (`frames.ts:118`).
    pub fn end(&self) -> Result<(), ScreenError> {
        if !matches!(self.phase, Phase::Length) || self.length_offset != 0 {
            return Err(ScreenError::Truncated);
        }
        Ok(())
    }

    fn reset(&mut self) {
        self.length = [0; 4];
        self.length_offset = 0;
        self.header_json.clear();
        self.header_offset = 0;
        self.header = None;
        self.packet.clear();
        self.payload_at = 0;
        self.phase = Phase::Length;
    }
}

impl Default for FrameDecoder {
    fn default() -> Self {
        FrameDecoder::new()
    }
}

fn integer(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.fract() == 0.0)
        .map(|value| value as i64)
}

fn safe_integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.fract() == 0.0 && *value >= 0.0 && *value <= MAX_SAFE_INTEGER)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn dimension(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.fract() == 0.0 && *value > 0.0 && *value <= 3_840.0)
        .map(|value| value as u32)
}

/// `/^[\w-]{1,64}$/`: letters, digits, `_` and `-`, at most 64.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `/^avc1\.[0-9a-fA-F]{6}$/`.
fn valid_video_codec(codec: &str) -> bool {
    codec
        .strip_prefix("avc1.")
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn rect_of(value: &Value) -> Option<DirtyRect> {
    let object = value.as_object()?;
    Some(DirtyRect {
        x: finite(object.get("x"))?,
        y: finite(object.get("y"))?,
        w: finite(object.get("w")).filter(|w| *w >= 0.0)?,
        h: finite(object.get("h")).filter(|h| *h >= 0.0)?,
    })
}

#[cfg(test)]
mod tests;
