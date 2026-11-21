// SPDX-License-Identifier: Apache-2.0
//! JPEG (ITU-T T.81): a walk of the marker structure that refuses a stream ending early,
//! then a strict decode. A cut-short stream is refused, never padded with grey.
use crate::error::{Failed, Result};
use crate::limits::MAX_SIDE;
use crate::raster::Raster;
use zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub width: u32,
    pub height: u32,
    /// EXIF orientation, 1 when absent.
    pub orientation: u8,
}

/// The stream's size and orientation, once its markers reach EOI. Entropy-coded data ends at
/// the first marker that isn't a stuffed byte or a restart marker.
pub fn scan(bytes: &[u8]) -> Result<Header> {
    let truncated = || Failed::truncated("JPEG");
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(Failed::decode("JPEG", "it has no start marker"));
    }
    let mut at = 2;
    let mut size = None;
    let mut orientation = 1;
    loop {
        if at >= bytes.len() {
            return Err(truncated());
        }
        if bytes[at] != 0xff {
            return Err(Failed::decode("JPEG", "a marker is missing"));
        }
        let Some(&marker) = bytes.get(at + 1) else {
            return Err(truncated());
        };
        match marker {
            0xff => {
                at += 1;
                continue;
            }
            0xd9 => break,
            0x01 | 0xd0..=0xd7 => {
                at += 2;
                continue;
            }
            _ => {}
        }
        let length = match bytes.get(at + 2..at + 4) {
            Some(b) => usize::from(u16::from_be_bytes([b[0], b[1]])),
            None => return Err(truncated()),
        };
        if length < 2 {
            return Err(Failed::decode("JPEG", "a segment has no length"));
        }
        let end = at + 2 + length;
        let segment = bytes.get(at + 4..end).ok_or_else(truncated)?;
        match marker {
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                if segment.len() < 5 {
                    return Err(Failed::decode("JPEG", "its frame header is short"));
                }
                let height = u32::from(u16::from_be_bytes([segment[1], segment[2]]));
                let width = u32::from(u16::from_be_bytes([segment[3], segment[4]]));
                size = Some((width, height));
            }
            0xe1 if segment.starts_with(b"Exif\0\0") && orientation == 1 => {
                orientation = crate::exif::orientation(&segment[6..]);
            }
            _ => {}
        }
        at = end;
        if marker == 0xda {
            at = entropy_end(bytes, at).ok_or_else(truncated)?;
        }
    }
    let (width, height) = size.ok_or_else(|| Failed::decode("JPEG", "it has no frame header"))?;
    Ok(Header {
        width,
        height,
        orientation,
    })
}

/// Where the entropy-coded data starting at `at` ends: the next real marker.
fn entropy_end(bytes: &[u8], mut at: usize) -> Option<usize> {
    while at + 1 < bytes.len() {
        if bytes[at] != 0xff {
            at += 1;
            continue;
        }
        match bytes[at + 1] {
            0x00 | 0xd0..=0xd7 => at += 2,
            0xff => at += 1,
            _ => return Some(at),
        }
    }
    None
}

/// The whole picture as RGBA, after [`scan`] accepted it.
pub fn decode(bytes: &[u8]) -> Result<Raster> {
    let options = DecoderOptions::default()
        .set_strict_mode(true)
        .set_max_width(MAX_SIDE as usize)
        .set_max_height(MAX_SIDE as usize)
        .jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let data = decoder.decode().map_err(|e| Failed::decode("JPEG", e))?;
    let info = decoder
        .info()
        .ok_or_else(|| Failed::decode("JPEG", "it has no size"))?;
    Raster::new(u32::from(info.width), u32::from(info.height), data)
        .map_err(|_| Failed::decode("JPEG", "its pixels don't match its size"))
}
