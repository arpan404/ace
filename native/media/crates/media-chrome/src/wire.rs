// SPDX-License-Identifier: Apache-2.0
//! The encoder page's protocol (pure). Pictures go to the page as binary WebSocket messages on
//! its input socket; encoded chunks come back as binary messages on its output socket, and
//! control replies as JSON text. Little-endian throughout.
//!
//! Picture, 32-byte header then the payload:
//!
//! ```text
//! 0  u8  kind 1        1  u8  format (1 JPEG, 2 RGBA, 3 BGRA, 4 NV12, 5 RGBX)
//! 2  u8  flags: bit 0 keyframe      3  u8  quantizer (0: the encoder's rate control)
//! 4  u32 sequence      8  u32 generation (the configuration it was sent under)
//! 12 u32 width         16 u32 height     20 u32 reserved
//! 24 u64 timestamp µs
//! ```
//!
//! Chunk, 24-byte header, then the decoder description (avcC, only on a keyframe whose
//! configuration changed), then the chunk's bytes:
//!
//! ```text
//! 0  u8  kind 1        1  u8  flags: bit 0 keyframe     2  u16 reserved
//! 4  u32 sequence      8  u32 generation     12 u32 description length
//! 16 u64 timestamp µs
//! ```

use crate::JpegSurface;
use media_codec::{CodecError, Picture, PixelFormat, Size};
use serde::{Deserialize, Serialize};

pub const PICTURE_HEADER: usize = 32;
pub const CHUNK_HEADER: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PictureFormat {
    Jpeg = 1,
    Rgba = 2,
    Bgra = 3,
    Nv12 = 4,
    Rgbx = 5,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PictureHeader {
    pub format: PictureFormat,
    pub key: bool,
    pub quantizer: Option<u8>,
    pub sequence: u32,
    pub generation: u32,
    pub size: Size,
    pub timestamp_us: u64,
}

/// One picture message: the header, then the pixels packed without row padding (RGB widened
/// to RGBX, since a `VideoFrame` has no 3-byte format) or the JPEG as it is. One copy.
pub fn picture_message(
    picture: &Picture,
    header: PictureHeader,
    out: &mut Vec<u8>,
) -> Result<(), CodecError> {
    out.clear();
    let mut fixed = [0u8; PICTURE_HEADER];
    fixed[0] = 1;
    fixed[1] = header.format as u8;
    fixed[2] = u8::from(header.key);
    fixed[3] = header.quantizer.unwrap_or(0);
    fixed[4..8].copy_from_slice(&header.sequence.to_le_bytes());
    fixed[8..12].copy_from_slice(&header.generation.to_le_bytes());
    fixed[12..16].copy_from_slice(&header.size.width.to_le_bytes());
    fixed[16..20].copy_from_slice(&header.size.height.to_le_bytes());
    fixed[24..32].copy_from_slice(&header.timestamp_us.to_le_bytes());
    out.extend_from_slice(&fixed);
    let width = header.size.width as usize;
    let height = header.size.height as usize;
    match picture {
        Picture::Platform(platform) => {
            let jpeg = platform
                .surface
                .as_any()
                .downcast_ref::<JpegSurface>()
                .ok_or_else(|| {
                    CodecError::Unsupported("the Chrome encoder takes JPEG or CPU pictures".into())
                })?;
            out.extend_from_slice(jpeg.bytes());
        }
        Picture::Cpu(cpu) => {
            let planes = cpu.planes();
            match cpu.format() {
                PixelFormat::Rgba8 | PixelFormat::Bgra8 => {
                    out.reserve(width * height * 4);
                    for row in planes[0].data.chunks(planes[0].stride).take(height) {
                        out.extend_from_slice(&row[..width * 4]);
                    }
                }
                PixelFormat::Rgb8 => {
                    out.reserve(width * height * 4);
                    for row in planes[0].data.chunks(planes[0].stride).take(height) {
                        for pixel in row[..width * 3].chunks_exact(3) {
                            out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                        }
                    }
                }
                PixelFormat::Nv12 => {
                    out.reserve(width * height * 3 / 2);
                    for (plane, rows) in planes.iter().zip([height, height / 2]) {
                        for row in plane.data.chunks(plane.stride).take(rows) {
                            out.extend_from_slice(&row[..width]);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// What a picture is sent as, from its storage.
pub fn picture_format(picture: &Picture) -> Result<PictureFormat, CodecError> {
    Ok(match picture {
        Picture::Platform(platform) => {
            if platform.surface.as_any().is::<JpegSurface>() {
                PictureFormat::Jpeg
            } else {
                return Err(CodecError::Unsupported(
                    "the Chrome encoder takes JPEG or CPU pictures".into(),
                ));
            }
        }
        Picture::Cpu(cpu) => match cpu.format() {
            PixelFormat::Rgba8 => PictureFormat::Rgba,
            PixelFormat::Bgra8 => PictureFormat::Bgra,
            PixelFormat::Nv12 => PictureFormat::Nv12,
            PixelFormat::Rgb8 => PictureFormat::Rgbx,
        },
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub key: bool,
    pub sequence: u32,
    pub generation: u32,
    pub timestamp_us: u64,
    pub description: Option<Vec<u8>>,
    pub data: Vec<u8>,
}

/// Parses a chunk message from the page; anything malformed is an error, never a panic.
pub fn parse_chunk(message: &[u8]) -> Result<Chunk, CodecError> {
    let bad = || CodecError::Backend("malformed chunk from the encoder page".into());
    let header = message.get(..CHUNK_HEADER).ok_or_else(bad)?;
    if header[0] != 1 {
        return Err(bad());
    }
    let u32_at = |at: usize| {
        let mut bytes = [0u8; 4];
        bytes.copy_from_slice(&header[at..at + 4]);
        u32::from_le_bytes(bytes)
    };
    let mut timestamp = [0u8; 8];
    timestamp.copy_from_slice(&header[16..24]);
    let description_len = u32_at(12) as usize;
    let rest = &message[CHUNK_HEADER..];
    if description_len > rest.len() {
        return Err(bad());
    }
    let (description, data) = rest.split_at(description_len);
    Ok(Chunk {
        key: header[1] & 1 == 1,
        sequence: u32_at(4),
        generation: u32_at(8),
        timestamp_us: u64::from_le_bytes(timestamp),
        description: (!description.is_empty()).then(|| description.to_vec()),
        data: data.to_vec(),
    })
}

/// Control messages to the page (JSON text on the input socket).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Configure {
        generation: u32,
        codec: String,
        width: u32,
        height: u32,
        fps: u32,
        /// Absent in quantizer mode: every picture then carries its own quantizer.
        #[serde(skip_serializing_if = "Option::is_none")]
        bitrate: Option<u32>,
        quantizer: bool,
    },
    Flush {
        generation: u32,
    },
}

/// Replies and notices from the page (JSON text on the output socket). Unknown kinds are kept
/// as `Other` and ignored, never fatal.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Notice {
    /// The answer to `Configure`: the page keeps its old encoder when `ok` is false.
    #[serde(rename_all = "camelCase")]
    Configured {
        generation: u32,
        ok: bool,
        #[serde(default)]
        reason: Option<String>,
    },
    /// A picture that produced no chunk (undecodable, or the encoder skipped it).
    Dropped { sequence: u32 },
    /// Every picture sent before `Flush` has come out.
    Flushed { generation: u32 },
    /// The page's encoder failed; it needs a new configuration.
    Failed { generation: u32, reason: String },
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_codec::{CpuPicture, Plane, PlatformPicture};

    fn header(format: PictureFormat, size: Size) -> PictureHeader {
        PictureHeader {
            format,
            key: true,
            quantizer: Some(30),
            sequence: 7,
            generation: 2,
            size,
            timestamp_us: 1_234_567,
        }
    }

    #[test]
    fn padded_rgb_rows_are_packed_and_widened_to_rgbx() -> Result<(), CodecError> {
        let size = Size {
            width: 2,
            height: 2,
        };
        let picture = Picture::Cpu(CpuPicture::new(
            size,
            PixelFormat::Rgb8,
            [Plane {
                data: vec![1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 9, 10, 11, 12, 0, 0],
                stride: 8,
            }],
            0,
        )?);
        let mut out = Vec::new();
        picture_message(&picture, header(picture_format(&picture)?, size), &mut out)?;
        assert_eq!(&out[..4], &[1, PictureFormat::Rgbx as u8, 1, 30]);
        assert_eq!(&out[4..8], &7u32.to_le_bytes());
        assert_eq!(&out[24..32], &1_234_567u64.to_le_bytes());
        assert_eq!(
            &out[PICTURE_HEADER..],
            &[1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]
        );
        Ok(())
    }

    #[test]
    fn nv12_keeps_both_planes_without_padding() -> Result<(), CodecError> {
        let size = Size {
            width: 2,
            height: 2,
        };
        let picture = Picture::Cpu(CpuPicture::new(
            size,
            PixelFormat::Nv12,
            [
                Plane {
                    data: vec![1, 2, 9, 3, 4, 9],
                    stride: 3,
                },
                Plane {
                    data: vec![5, 6, 9],
                    stride: 3,
                },
            ],
            0,
        )?);
        let mut out = Vec::new();
        picture_message(&picture, header(PictureFormat::Nv12, size), &mut out)?;
        assert_eq!(&out[PICTURE_HEADER..], &[1, 2, 3, 4, 5, 6]);
        Ok(())
    }

    struct Other;
    impl media_codec::PlatformSurface for Other {
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[test]
    fn a_platform_surface_other_than_jpeg_is_refused() {
        let picture = Picture::Platform(PlatformPicture {
            size: Size {
                width: 2,
                height: 2,
            },
            format: PixelFormat::Nv12,
            pts_us: 0,
            surface: Box::new(Other),
        });
        assert!(matches!(
            picture_format(&picture),
            Err(CodecError::Unsupported(_))
        ));
    }

    #[test]
    fn chunks_split_description_from_data_and_reject_short_input() -> Result<(), CodecError> {
        let mut message = vec![1u8, 1, 0, 0];
        message.extend_from_slice(&9u32.to_le_bytes());
        message.extend_from_slice(&3u32.to_le_bytes());
        message.extend_from_slice(&2u32.to_le_bytes());
        message.extend_from_slice(&5_000u64.to_le_bytes());
        message.extend_from_slice(&[0xAA, 0xBB, 1, 2, 3]);
        let chunk = parse_chunk(&message)?;
        assert_eq!(
            chunk,
            Chunk {
                key: true,
                sequence: 9,
                generation: 3,
                timestamp_us: 5_000,
                description: Some(vec![0xAA, 0xBB]),
                data: vec![1, 2, 3],
            }
        );
        // A description longer than the message, a truncated header, a wrong kind.
        message[12] = 200;
        assert!(parse_chunk(&message).is_err());
        assert!(parse_chunk(&message[..10]).is_err());
        assert!(parse_chunk(&[2; CHUNK_HEADER]).is_err());
        Ok(())
    }

    #[test]
    fn unknown_notices_are_kept_as_other() -> Result<(), serde_json::Error> {
        let notice: Notice = serde_json::from_str(r#"{"t":"stats","fps":30}"#)?;
        assert_eq!(notice, Notice::Other);
        let notice: Notice = serde_json::from_str(r#"{"t":"dropped","sequence":4}"#)?;
        assert_eq!(notice, Notice::Dropped { sequence: 4 });
        Ok(())
    }
}
