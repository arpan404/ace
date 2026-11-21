// SPDX-License-Identifier: Apache-2.0
//! WebP (lossy, lossless, with alpha; an animation's first frame).
use crate::error::{Failed, Result};
use crate::limits::check_input;
use crate::raster::Raster;
use image_webp::{DecodingError, WebPDecoder};
use std::io::Cursor;

fn failed(error: DecodingError) -> Failed {
    match error {
        DecodingError::IoError(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            Failed::truncated("WebP")
        }
        DecodingError::ImageTooLarge | DecodingError::MemoryLimitExceeded => {
            Failed::too_large("The WebP is too large to decode.")
        }
        other => Failed::decode("WebP", other),
    }
}

/// A RIFF file says how long it is: fewer bytes than that is a file cut short.
fn whole(bytes: &[u8]) -> Result<()> {
    let declared = bytes
        .get(4..8)
        .map(|b| u64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])) + 8);
    match declared {
        Some(length) if bytes.len() as u64 >= length => Ok(()),
        _ => Err(Failed::truncated("WebP")),
    }
}

pub fn header(bytes: &[u8]) -> Result<(u32, u32)> {
    whole(bytes)?;
    let decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(failed)?;
    Ok(decoder.dimensions())
}

pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<Raster> {
    whole(bytes)?;
    let mut decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(failed)?;
    let (width, height) = decoder.dimensions();
    check_input(width, height, max_pixels)?;
    let size = decoder
        .output_buffer_size()
        .ok_or_else(|| Failed::too_large("The WebP is too large to decode."))?;
    let pixels = width as usize * height as usize;
    let mut buffer = vec![0; size.max(pixels * 4)];
    decoder.read_image(&mut buffer[..size]).map_err(failed)?;
    if !decoder.has_alpha() {
        crate::png::widen_rgb(&mut buffer, pixels);
    }
    buffer.truncate(pixels * 4);
    let data = buffer;
    Raster::new(width, height, data)
}
