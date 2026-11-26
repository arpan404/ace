// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-protocol.ts`'s video half and `scrcpy-video.ts`: the video socket's framing (a u32
//! codec id, 12-byte session packets, media packets with a size and payload) and the units a
//! capture hands to ace-media. The latest codec configuration is repeated in front of every
//! keyframe, so a viewer can join at any IDR. Pure: no sockets, no clocks; work per chunk is the
//! chunk's, never the stream's.
//!
//! A capture runs this in-process, so no chunk crosses the addon per frame; if a unit is ever
//! wired that way, it needs a paired median measurement against the TypeScript first.

use serde::{Deserialize, Serialize};

use crate::platform::Error;

/// scrcpy's H.264 codec id (`'h264'` as a big-endian word).
pub const H264: u32 = 0x6832_3634;
/// The largest one media packet may hold.
pub const MAX_PACKET: usize = 8 * 1024 * 1024;
/// The largest codec configuration a packet may carry.
pub const CONFIG_LIMIT: usize = 64 * 1024;
/// The largest picture any capture session may announce.
pub const DIMENSION_LIMIT: u32 = 16_384;

/// One event off the video socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoEvent {
    Codec {
        id: u32,
    },
    Session {
        width: u32,
        height: u32,
    },
    Packet {
        config: bool,
        keyframe: bool,
        pts: i64,
        payload: Vec<u8>,
    },
}

/// A capture's own video unit, as `scrcpy-video.ts` declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoUnit {
    /// Annex B access unit; a keyframe carries the parameter sets in front of it.
    pub payload: Vec<u8>,
    pub keyframe: bool,
    /// RFC 6381 codec string read from the stream's SPS.
    pub video_codec: String,
    pub width: u32,
    pub height: u32,
    /// Encoder timestamp in microseconds.
    pub pts: i64,
    /// The encode it belongs to: none for the source's own stream, else a re-encode.
    pub encode: Option<u32>,
}

/// Reads the video socket after the connection preamble.
#[derive(Debug)]
pub struct VideoStreamReader {
    buffer: Vec<u8>,
    start: usize,
    codec: bool,
    max_packet: usize,
}

impl VideoStreamReader {
    pub fn new(max_packet: usize) -> Self {
        Self {
            buffer: Vec::new(),
            start: 0,
            codec: false,
            max_packet,
        }
    }

    /// Adds one socket chunk and returns every event it completed, in stream order.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<VideoEvent>, Error> {
        if chunk.is_empty() {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        loop {
            let available = self.buffer.len() - self.start;
            if !self.codec {
                if available < 4 {
                    break;
                }
                let at = self.start;
                self.codec = true;
                events.push(VideoEvent::Codec {
                    id: u32::from_be_bytes(
                        self.buffer[at..at + 4]
                            .try_into()
                            .map_err(|_| invalid("scrcpy video header is truncated"))?,
                    ),
                });
                self.start += 4;
                continue;
            }
            if available < 12 {
                break;
            }
            let at = self.start;
            let first = self.buffer[at];
            if first & 0x80 != 0 {
                let width = u32::from_be_bytes(
                    self.buffer[at + 4..at + 8]
                        .try_into()
                        .map_err(|_| invalid("scrcpy video session is truncated"))?,
                );
                let height = u32::from_be_bytes(
                    self.buffer[at + 8..at + 12]
                        .try_into()
                        .map_err(|_| invalid("scrcpy video session is truncated"))?,
                );
                self.start += 12;
                events.push(VideoEvent::Session { width, height });
                continue;
            }
            let size = usize::try_from(u32::from_be_bytes(
                self.buffer[at + 8..at + 12]
                    .try_into()
                    .map_err(|_| invalid("scrcpy video packet is truncated"))?,
            ))
            .map_err(|_| invalid("scrcpy video packet exceeds limit"))?;
            if size > self.max_packet {
                return Err(invalid("scrcpy video packet exceeds limit"));
            }
            if available < 12 + size {
                break;
            }
            let word = u64::from_be_bytes(
                self.buffer[at..at + 8]
                    .try_into()
                    .map_err(|_| invalid("scrcpy video packet is truncated"))?,
            );
            let payload = self.buffer[at + 12..at + 12 + size].to_vec();
            self.start += 12 + size;
            events.push(VideoEvent::Packet {
                config: first & 0x40 != 0,
                keyframe: first & 0x20 != 0,
                pts: i64::try_from(word & ((1 << 61) - 1))
                    .map_err(|_| invalid("scrcpy video timestamp is out of range"))?,
                payload,
            });
        }
        self.compact();
        Ok(events)
    }

    fn compact(&mut self) {
        if self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        } else if self.start >= 64 * 1024 {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
    }
}

/// The `avc1.PPCCLL` codec string from the first SPS in an Annex B buffer.
pub fn avc_codec(config: &[u8]) -> Option<String> {
    for index in 0..config.len().saturating_sub(7) {
        if config[index] != 0 || config[index + 1] != 0 {
            continue;
        }
        let start = if config[index + 2] == 1 {
            index + 3
        } else if config[index + 2] == 0 && config[index + 3] == 1 {
            index + 4
        } else {
            continue;
        };
        if start + 3 >= config.len() {
            continue;
        }
        if config[start] & 31 == 7 {
            return Some(format!(
                "avc1.{:02X}{:02X}{:02X}",
                config[start + 1],
                config[start + 2],
                config[start + 3]
            ));
        }
    }
    None
}

/// What [`ScrcpyVideoUnits`] hands on: a unit, or a new session's size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitsEvent {
    Unit(VideoUnit),
    Resized { width: u32, height: u32 },
}

/// Turns scrcpy video events into self-describing access units: the latest codec configuration
/// is kept and repeated in front of every keyframe.
#[derive(Debug)]
pub struct ScrcpyVideoUnits {
    config: Option<Vec<u8>>,
    codec: String,
    width: u32,
    height: u32,
}

impl ScrcpyVideoUnits {
    pub fn new() -> Self {
        Self {
            config: None,
            codec: "avc1.42E01F".to_string(),
            width: 0,
            height: 0,
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Parameter sets for a decoder that joins mid-stream.
    pub fn parameters(&self) -> Option<&[u8]> {
        self.config.as_deref()
    }

    pub fn push(&mut self, event: VideoEvent) -> Result<Vec<UnitsEvent>, Error> {
        match event {
            VideoEvent::Codec { id } => {
                if id != H264 {
                    return Err(invalid(&format!(
                        "scrcpy sent an unsupported video codec 0x{id:x}"
                    )));
                }
                Ok(Vec::new())
            }
            VideoEvent::Session { width, height } => {
                if width == 0 || height == 0 || width > DIMENSION_LIMIT || height > DIMENSION_LIMIT
                {
                    return Err(invalid("scrcpy sent an invalid video size"));
                }
                self.width = width;
                self.height = height;
                // A new capture session (rotation, resize) starts with fresh parameter sets.
                self.config = None;
                Ok(vec![UnitsEvent::Resized { width, height }])
            }
            VideoEvent::Packet {
                config,
                keyframe,
                pts,
                payload,
            } => {
                if config {
                    if payload.len() > CONFIG_LIMIT {
                        return Err(invalid("scrcpy codec config exceeds limit"));
                    }
                    if let Some(codec) = avc_codec(&payload) {
                        self.codec = codec;
                    }
                    self.config = Some(payload);
                    return Ok(Vec::new());
                }
                if self.width == 0 || self.height == 0 {
                    return Err(invalid("scrcpy sent video before its size"));
                }
                let payload = if keyframe {
                    match &self.config {
                        Some(config) => {
                            let mut joined = Vec::with_capacity(config.len() + payload.len());
                            joined.extend_from_slice(config);
                            joined.extend_from_slice(&payload);
                            joined
                        }
                        None => payload,
                    }
                } else {
                    if self.config.is_none() {
                        // A delta before the first keyframe of a session decodes for no one.
                        return Ok(Vec::new());
                    }
                    payload
                };
                Ok(vec![UnitsEvent::Unit(VideoUnit {
                    payload,
                    keyframe,
                    video_codec: self.codec.clone(),
                    width: self.width,
                    height: self.height,
                    pts,
                    encode: None,
                })])
            }
        }
    }
}

impl Default for ScrcpyVideoUnits {
    fn default() -> Self {
        Self::new()
    }
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.to_string())
}

#[cfg(test)]
mod tests;
