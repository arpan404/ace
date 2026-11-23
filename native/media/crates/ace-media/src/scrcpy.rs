// SPDX-License-Identifier: Apache-2.0
//! Scrcpy's video socket as ace-media reads it (D1): the pure half. The shell's reader
//! thread does the I/O (`shell::scrcpy`); this splits what it reads, beside `serve_sim.rs`.
//!
//! After the one dummy byte the server sends on the first connection come the 64-byte
//! device name and then, after the daemon connects control, a u32 codec id and 12-byte
//! session packets (MSB set, then width and height) or media packets (flags and PTS in a
//! u64, then a u32 size and that many bytes of the encoder's output). Each access unit
//! becomes one MediaFrame, the latest codec configuration repeated in front of every
//! keyframe, as the daemon publishes them today.
//!
//! [`VideoStreamReader`] returns borrowed parsing as owned events; [`VideoUnits`] turns
//! those into self-describing units. Work per push is proportional to the bytes pushed.

use media_wire::frame::MediaFrame;

/// The device name's bytes on the wire, up to the first NUL.
pub const DEVICE_NAME_LEN: usize = 64;
/// The only codec id ace takes from scrcpy: H.264 (`videoCodecId.h264`).
pub const CODEC_H264: u32 = 0x6832_3634;
/// Largest media packet, as the daemon's reader allows (8 MiB scrcpy packets).
pub const MAX_PACKET: usize = 8 * 1024 * 1024;
/// Largest codec configuration the reader keeps (the daemon refuses more).
const MAX_CONFIG: usize = 64 * 1024;
/// Largest picture edge the reader takes (the daemon refuses more).
const MAX_EDGE: u32 = 16384;

/// What the video socket carries after the device name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Codec(u32),
    Session {
        width: u32,
        height: u32,
    },
    Packet {
        config: bool,
        keyframe: bool,
        pts: u64,
        payload: Vec<u8>,
    },
}

/// Why a video socket's bytes are unusable: the capture fails, as the daemon's does today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrcpyError {
    /// A media packet names more bytes than the frame budget.
    PacketTooLarge,
    /// Any codec id but H.264.
    UnsupportedCodec,
    /// A session with no picture, or past what encoders take.
    InvalidSize,
    /// A codec configuration past what the reader keeps.
    ConfigTooLarge,
    /// A media packet before the session named the picture's size.
    PacketBeforeSize,
    /// A picture that doesn't fit the frame the reader reports.
    PictureTooLarge,
}

/// Splits the video socket after the device name into codec, session and media packets.
#[derive(Debug, Default)]
pub struct VideoStreamReader {
    buffer: Vec<u8>,
    start: usize,
    codec: bool,
    max_packet: usize,
}

impl VideoStreamReader {
    pub fn new() -> Self {
        Self {
            max_packet: MAX_PACKET,
            ..Self::default()
        }
    }

    /// Feeds `bytes`; whole codec, session and media packets are appended to `out`.
    /// A packet inside one push is moved, not copied twice.
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<Event>) -> Result<(), ScrcpyError> {
        self.buffer.extend_from_slice(bytes);
        loop {
            if !self.codec {
                if self.available() < 4 {
                    break;
                }
                let id = u32::from_be_bytes(self.head());
                self.consume(4);
                self.codec = true;
                out.push(Event::Codec(id));
                continue;
            }
            if self.available() < 12 {
                break;
            }
            let head: [u8; 12] = self.head();
            if head[0] & 0x80 != 0 {
                self.consume(12);
                out.push(Event::Session {
                    width: u32::from_be_bytes([head[4], head[5], head[6], head[7]]),
                    height: u32::from_be_bytes([head[8], head[9], head[10], head[11]]),
                });
                continue;
            }
            let size = u32::from_be_bytes([head[8], head[9], head[10], head[11]]) as usize;
            if size > self.max_packet {
                return Err(ScrcpyError::PacketTooLarge);
            }
            if self.available() < 12 + size {
                break;
            }
            let word = u64::from_be_bytes(self.head());
            self.consume(12);
            let payload = self.take(size);
            out.push(Event::Packet {
                config: head[0] & 0x40 != 0,
                keyframe: head[0] & 0x20 != 0,
                pts: word & ((1 << 61) - 1),
                payload,
            });
        }
        self.compact();
        Ok(())
    }

    fn available(&self) -> usize {
        self.buffer.len() - self.start
    }

    fn head<const N: usize>(&self) -> [u8; N] {
        let mut head = [0; N];
        head.copy_from_slice(&self.buffer[self.start..self.start + N]);
        head
    }

    fn consume(&mut self, count: usize) {
        self.start += count;
    }

    fn take(&mut self, count: usize) -> Vec<u8> {
        let out = self.buffer[self.start..self.start + count].to_vec();
        self.start += count;
        out
    }

    /// Keeps only what isn't a whole packet yet.
    fn compact(&mut self) {
        if self.start > 0 && self.start * 2 >= self.buffer.len() {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
    }
}

/// One access unit: Annex B, a keyframe carrying the stream's parameter sets in front.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoUnit {
    pub payload: Vec<u8>,
    pub keyframe: bool,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub pts: u64,
}

/// Turns video events into self-describing access units: the latest codec configuration
/// is kept and repeated in front of every keyframe, so a viewer can join at any IDR.
#[derive(Debug)]
pub struct VideoUnits {
    config: Option<Vec<u8>>,
    codec: String,
    width: u32,
    height: u32,
}

impl Default for VideoUnits {
    fn default() -> Self {
        Self {
            config: None,
            codec: "avc1.42E01F".to_owned(),
            width: 0,
            height: 0,
        }
    }
}

impl VideoUnits {
    pub fn new() -> Self {
        Self::default()
    }

    /// The picture's size: a new capture session (rotation, resize) starts with fresh
    /// parameter sets.
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Parameter sets for a decoder that joins mid-stream.
    pub fn parameters(&self) -> Option<&[u8]> {
        self.config.as_deref()
    }

    /// Turns one event into zero or one units, appended to `out`. A delta before the first
    /// keyframe of a session is dropped: nothing can decode it.
    pub fn push(&mut self, event: Event, out: &mut Vec<VideoUnit>) -> Result<(), ScrcpyError> {
        match event {
            Event::Codec(id) => {
                if id != CODEC_H264 {
                    return Err(ScrcpyError::UnsupportedCodec);
                }
                Ok(())
            }
            Event::Session { width, height } => {
                if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
                    return Err(ScrcpyError::InvalidSize);
                }
                self.width = width;
                self.height = height;
                self.config = None;
                Ok(())
            }
            Event::Packet {
                config,
                keyframe,
                pts,
                payload,
            } => {
                if config {
                    if payload.len() > MAX_CONFIG {
                        return Err(ScrcpyError::ConfigTooLarge);
                    }
                    if let Some(codec) = avc_codec(&payload) {
                        self.codec = codec;
                    }
                    self.config = Some(payload);
                    return Ok(());
                }
                if self.width == 0 || self.height == 0 {
                    return Err(ScrcpyError::PacketBeforeSize);
                }
                if self.config.is_none() && !keyframe {
                    return Ok(());
                }
                let mut joined = self.config.clone().unwrap_or_default();
                if keyframe {
                    joined.extend_from_slice(&payload);
                } else {
                    joined = payload;
                }
                out.push(VideoUnit {
                    payload: joined,
                    keyframe,
                    codec: self.codec.clone(),
                    width: self.width,
                    height: self.height,
                    pts,
                });
                Ok(())
            }
        }
    }
}

/// The device name: bytes up to the first NUL, decoded as UTF-8 like `toString("utf8")`.
pub fn device_name(bytes: &[u8; DEVICE_NAME_LEN]) -> String {
    let end = bytes
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// The `avc1.PPCCLL` codec string from the first SPS in an Annex B buffer.
pub fn avc_codec(config: &[u8]) -> Option<String> {
    for (index, window) in config.windows(4).enumerate() {
        if window[0] != 0 || window[1] != 0 {
            continue;
        }
        let start = if window[2] == 1 {
            index + 3
        } else if window[2] == 0 && config.get(index + 3) == Some(&1) {
            index + 4
        } else {
            continue;
        };
        let nal = config.get(start)?;
        if nal & 31 != 7 {
            continue;
        }
        let profile = config.get(start + 1)?;
        let constraints = config.get(start + 2)?;
        let level = config.get(start + 3)?;
        return Some(format!("avc1.{profile:02X}{constraints:02X}{level:02X}"));
    }
    None
}

/// A unit as the MediaFrame the engine delivers and records, as serve-sim's reader makes.
pub fn unit_frame(unit: &VideoUnit) -> Result<MediaFrame, ScrcpyError> {
    let width = u16::try_from(unit.width).map_err(|_| ScrcpyError::PictureTooLarge)?;
    let height = u16::try_from(unit.height).map_err(|_| ScrcpyError::PictureTooLarge)?;
    Ok(MediaFrame {
        kind: 1,
        flags: u32::from(unit.keyframe),
        age_us: 0,
        width,
        height,
        display_width: width,
        display_height: height,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode: 0,
        epoch: 0,
        codec_string: if unit.keyframe {
            unit.codec.clone()
        } else {
            String::new()
        },
        description: Vec::new(),
        extension: Vec::new(),
        payload: unit.payload.clone(),
    })
}

/// The MediaFrame extension that names the reader generation a unit came from: tag 2,
/// length 4, the generation as a big-endian u32 (beside the producer stamp's tag 1). The
/// daemon drops a unit whose generation isn't its source's current one.
pub fn dial_tag(dial: u32) -> [u8; 8] {
    let mut tag = [0, 2, 0, 4, 0, 0, 0, 0];
    tag[4..].copy_from_slice(&dial.to_be_bytes());
    tag
}

#[cfg(test)]
#[path = "scrcpy_tests.rs"]
mod tests;
