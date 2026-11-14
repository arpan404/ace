// SPDX-License-Identifier: Apache-2.0
//! serve-sim's H.264, read by ace-media itself (E3b): the pure half. The shell's reader thread
//! does the I/O (`shell::readers`); this decodes what it reads.
//!
//! `/stream.avcc` is an HTTP response whose body is a run of records: a u32 big-endian length,
//! then that many bytes, the first a tag. Tag 1 is an avcC decoder configuration, 2 an IDR access
//! unit and 3 a delta, both as length-prefixed NAL units. Other tags (a JPEG preview seed, later
//! additions) are skipped. Each access unit becomes one MediaFrame as the daemon publishes it
//! today: Annex B, the parameter sets in front of every keyframe, the picture's size and codec.
use media_bitstream::avcc::AvcConfig;
use media_bitstream::h264::Sps;
use media_bitstream::nal::length_prefixed_to_annex_b;
use media_wire::frame::MediaFrame;

/// Largest record, as the daemon's reader allows.
pub const RECORD_LIMIT: usize = 8 * 1024 * 1024;
/// Most bytes of status line and headers.
const HEAD_LIMIT: usize = 16 * 1024;
/// Most bytes of a chunk-size line.
const CHUNK_LINE_LIMIT: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    /// Not `200`, or a response this reader can't follow.
    Response(String),
    /// A malformed record or body.
    Stream(&'static str),
}

/// Where an HTTP/1.1 response is: its head, then a body sent as is or in chunks.
enum Body {
    Head,
    Identity,
    /// Inside a chunk with this many bytes left.
    Chunk(usize),
    /// Reading a chunk's size line.
    Size,
    /// After a chunk's data: its CRLF.
    ChunkEnd,
    Done,
}

/// Turns the bytes of one response into the bytes of its body, incrementally.
pub struct HttpBody {
    state: Body,
    chunked: bool,
    buffer: Vec<u8>,
}

impl Default for HttpBody {
    fn default() -> Self {
        Self {
            state: Body::Head,
            chunked: false,
            buffer: Vec::new(),
        }
    }
}

impl HttpBody {
    /// Feeds `bytes`; the body bytes they carry are appended to `body`.
    pub fn push(&mut self, mut bytes: &[u8], body: &mut Vec<u8>) -> Result<(), ReadError> {
        while !bytes.is_empty() {
            match self.state {
                Body::Head => {
                    self.buffer.extend_from_slice(bytes);
                    bytes = &[];
                    let Some(end) = find(&self.buffer, b"\r\n\r\n") else {
                        if self.buffer.len() > HEAD_LIMIT {
                            return Err(ReadError::Response("response head too long".into()));
                        }
                        continue;
                    };
                    let head = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
                    let rest = self.buffer.split_off(end + 4);
                    self.buffer.clear();
                    self.head(&head)?;
                    self.push(&rest, body)?;
                }
                Body::Identity => {
                    body.extend_from_slice(bytes);
                    bytes = &[];
                }
                Body::Chunk(left) => {
                    let take = left.min(bytes.len());
                    body.extend_from_slice(&bytes[..take]);
                    bytes = &bytes[take..];
                    self.state = if take == left {
                        Body::ChunkEnd
                    } else {
                        Body::Chunk(left - take)
                    };
                }
                Body::ChunkEnd | Body::Size => {
                    let byte = bytes[0];
                    bytes = &bytes[1..];
                    if matches!(self.state, Body::ChunkEnd) {
                        if byte == b'\n' {
                            self.state = Body::Size;
                        }
                        continue;
                    }
                    if byte != b'\n' {
                        self.buffer.push(byte);
                        if self.buffer.len() > CHUNK_LINE_LIMIT {
                            return Err(ReadError::Stream("chunk size line too long"));
                        }
                        continue;
                    }
                    let line = String::from_utf8_lossy(&self.buffer).into_owned();
                    self.buffer.clear();
                    let size = line.trim().split(';').next().unwrap_or_default();
                    let size = usize::from_str_radix(size.trim(), 16)
                        .map_err(|_| ReadError::Stream("chunk size is not hex"))?;
                    self.state = if size == 0 {
                        Body::Done
                    } else {
                        Body::Chunk(size)
                    };
                }
                Body::Done => bytes = &[],
            }
        }
        Ok(())
    }

    /// The body has ended (a last chunk); a stream's end is the producer stopping.
    pub fn finished(&self) -> bool {
        matches!(self.state, Body::Done)
    }

    fn head(&mut self, head: &str) -> Result<(), ReadError> {
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap_or_default();
        let code = status.split(' ').nth(1).unwrap_or_default();
        if code != "200" {
            return Err(ReadError::Response(format!("status {code}")));
        }
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.trim().eq_ignore_ascii_case("transfer-encoding") {
                let value = value.trim().to_ascii_lowercase();
                if value != "chunked" {
                    return Err(ReadError::Response(format!("transfer encoding {value}")));
                }
                self.chunked = true;
            }
        }
        self.state = if self.chunked {
            Body::Size
        } else {
            Body::Identity
        };
        Ok(())
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// One serve-sim record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    Description(Vec<u8>),
    Key(Vec<u8>),
    Delta(Vec<u8>),
    Other(u8),
}

/// Splits a body into records. Work per push is proportional to the bytes pushed.
#[derive(Default)]
pub struct Records {
    buffer: Vec<u8>,
    start: usize,
}

impl Records {
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<Record>) -> Result<(), ReadError> {
        self.buffer.extend_from_slice(bytes);
        loop {
            let available = &self.buffer[self.start..];
            if available.len() < 4 {
                break;
            }
            let length =
                u32::from_be_bytes([available[0], available[1], available[2], available[3]])
                    as usize;
            if length == 0 || length > RECORD_LIMIT {
                return Err(ReadError::Stream("record length out of bounds"));
            }
            if available.len() < 4 + length {
                break;
            }
            let record = &available[4..4 + length];
            let body = record[1..].to_vec();
            out.push(match record[0] {
                1 => Record::Description(body),
                2 => Record::Key(body),
                3 => Record::Delta(body),
                tag => Record::Other(tag),
            });
            self.start += 4 + length;
        }
        // Keep only what isn't a whole record yet.
        if self.start > 0 && self.start * 2 >= self.buffer.len() {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
        Ok(())
    }
}

/// The decoder configuration in effect: its parameter sets as Annex B, size and codec string.
struct Config {
    /// The avcC record as serve-sim sent it, for a decoder.
    record: Vec<u8>,
    length_size: usize,
    parameters: Vec<u8>,
    width: u16,
    height: u16,
    codec: String,
}

/// Records into MediaFrames, as the daemon publishes serve-sim's video today.
#[derive(Default)]
pub struct Translator {
    config: Option<Config>,
}

impl Translator {
    /// A unit as a MediaFrame, or none (a description, a skipped tag). The epoch is the
    /// engine's to stamp.
    pub fn frame(&mut self, record: Record) -> Result<Option<MediaFrame>, ReadError> {
        let (body, key) = match record {
            Record::Description(body) => {
                self.config = Some(config(&body)?);
                return Ok(None);
            }
            Record::Other(_) => return Ok(None),
            Record::Key(body) => (body, true),
            Record::Delta(body) => (body, false),
        };
        let Some(config) = &self.config else {
            return Err(ReadError::Stream("a unit came before its description"));
        };
        let mut sample = Vec::new();
        length_prefixed_to_annex_b(&body, config.length_size, &mut sample)
            .map_err(|_| ReadError::Stream("a unit's NAL lengths don't fit it"))?;
        let payload = if key {
            let mut joined = Vec::with_capacity(config.parameters.len() + sample.len());
            joined.extend_from_slice(&config.parameters);
            joined.extend_from_slice(&sample);
            joined
        } else {
            sample
        };
        Ok(Some(MediaFrame {
            kind: 1,
            flags: u32::from(key),
            age_us: 0,
            width: config.width,
            height: config.height,
            display_width: config.width,
            display_height: config.height,
            scale: 1000,
            rotation: 0,
            codec: 1,
            encode: 0,
            epoch: 0,
            codec_string: if key {
                config.codec.clone()
            } else {
                String::new()
            },
            description: Vec::new(),
            extension: Vec::new(),
            payload,
        }))
    }
}

impl Translator {
    /// A unit as a decoder takes it (length-prefixed, its avcC on keyframes), for the
    /// transcode; none before a description, or for anything but a unit.
    pub fn source(&self, record: &Record, pts_us: u64) -> Option<media_codec::EncodedUnit> {
        let (body, key) = match record {
            Record::Key(body) => (body, true),
            Record::Delta(body) => (body, false),
            _ => return None,
        };
        let config = self.config.as_ref()?;
        Some(media_codec::EncodedUnit {
            codec: media_codec::Codec::H264,
            size: media_codec::Size {
                width: u32::from(config.width),
                height: u32::from(config.height),
            },
            format: media_codec::BitstreamFormat::Avcc,
            data: body.clone(),
            key,
            description: key.then(|| config.record.clone()),
            pts_us,
            duration_us: 0,
        })
    }
}

fn config(record: &[u8]) -> Result<Config, ReadError> {
    let avc = AvcConfig::parse(record).map_err(|_| ReadError::Stream("avcC is invalid"))?;
    let sps = avc
        .sps
        .first()
        .ok_or(ReadError::Stream("avcC has no SPS"))?;
    let (width, height) = Sps::parse(sps)
        .map_err(|_| ReadError::Stream("SPS is invalid"))?
        .frame_size();
    let mut parameters = Vec::new();
    for unit in avc.sps.iter().chain(avc.pps.iter()) {
        parameters.extend_from_slice(&[0, 0, 0, 1]);
        parameters.extend_from_slice(unit);
    }
    Ok(Config {
        record: record.to_vec(),
        length_size: usize::from(avc.length_size),
        parameters,
        width: u16::try_from(width).map_err(|_| ReadError::Stream("picture too wide"))?,
        height: u16::try_from(height).map_err(|_| ReadError::Stream("picture too tall"))?,
        codec: avc.codec_string(),
    })
}

/// `http://127.0.0.1:<port>/<path>` or `localhost`: serve-sim listens on loopback only, and no
/// other address is ever dialled.
pub fn loopback_url(url: &str) -> Option<(u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    let (host, port) = authority.rsplit_once(':')?;
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    let port = port.parse().ok().filter(|p| *p != 0)?;
    if path.chars().any(|c| c.is_ascii_control() || c == ' ') {
        return None;
    }
    Some((port, format!("/{path}")))
}

#[cfg(test)]
#[path = "serve_sim_tests.rs"]
mod tests;
