// SPDX-License-Identifier: Apache-2.0
//! PNG in (any bit depth and colour type, expanded to 8-bit RGBA) and out.
use crate::error::{Failed, Result};
use crate::limits::check_input;
use crate::raster::Raster;
use png::{BitDepth, ColorType, Transformations};
use std::io::Cursor;

fn failed(error: png::DecodingError) -> Failed {
    match error {
        png::DecodingError::IoError(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            Failed::truncated("PNG")
        }
        png::DecodingError::LimitsExceeded => {
            Failed::too_large("The PNG needs more memory than ace allows.")
        }
        other => Failed::decode("PNG", other),
    }
}

fn reader(bytes: &[u8]) -> Result<png::Decoder<Cursor<&[u8]>>> {
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(bytes),
        png::Limits {
            bytes: crate::limits::MAX_DECODE_BYTES,
        },
    );
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    Ok(decoder)
}

/// The chunk structure (PNG §5.3): IHDR first, at least one IDAT, and IEND, each chunk whole.
/// The pixels aren't inflated: a file cut after its header, or anywhere before IEND, is cut.
fn whole(bytes: &[u8]) -> Result<()> {
    let mut at = 8;
    let (mut first, mut data) = (true, false);
    loop {
        let Some(head) = bytes.get(at..at + 8) else {
            return Err(Failed::truncated("PNG"));
        };
        let length = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let kind = &head[4..8];
        if length > 0x7fff_ffff || (first && kind != b"IHDR") {
            return Err(Failed::decode("PNG", "its chunks are out of order"));
        }
        first = false;
        let end = at + 12 + length;
        if end > bytes.len() {
            return Err(Failed::truncated("PNG"));
        }
        data |= kind == b"IDAT";
        if kind == b"IEND" {
            return if data {
                Ok(())
            } else {
                Err(Failed::truncated("PNG"))
            };
        }
        at = end;
    }
}

/// The stored size, from IHDR, once the file is whole.
pub fn header(bytes: &[u8]) -> Result<(u32, u32)> {
    whole(bytes)?;
    let mut decoder = reader(bytes)?;
    let info = decoder.read_header_info().map_err(failed)?;
    Ok((info.width, info.height))
}

/// Widens `channels`-sample pixels in place to RGBA, from the end so nothing is overwritten
/// before it is read.
fn widen(buffer: &mut [u8], pixels: usize, channels: usize) {
    for i in (0..pixels).rev() {
        let from = i * channels;
        let p = match channels {
            1 => [buffer[from], buffer[from], buffer[from], 255],
            2 => [buffer[from], buffer[from], buffer[from], buffer[from + 1]],
            _ => [buffer[from], buffer[from + 1], buffer[from + 2], 255],
        };
        buffer[i * 4..i * 4 + 4].copy_from_slice(&p);
    }
}

/// The default image as RGBA, decoded into the one buffer it ends in.
pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<Raster> {
    let (width, height) = header(bytes)?;
    check_input(width, height, max_pixels)?;
    let mut reader = reader(bytes)?.read_info().map_err(failed)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| Failed::too_large("The PNG is too large to decode."))?;
    let pixels = width as usize * height as usize;
    let mut buffer = vec![0; size.max(pixels * 4)];
    let frame = reader.next_frame(&mut buffer).map_err(failed)?;
    reader.finish().map_err(failed)?;
    let channels = match (frame.color_type, frame.bit_depth) {
        (ColorType::Rgba, BitDepth::Eight) => 4,
        (ColorType::Rgb, BitDepth::Eight) => 3,
        (ColorType::GrayscaleAlpha, BitDepth::Eight) => 2,
        (ColorType::Grayscale, BitDepth::Eight) => 1,
        (color, depth) => {
            return Err(Failed::decode(
                "PNG",
                format!("{color:?} at {depth:?} bits is not expanded to 8-bit"),
            ));
        }
    };
    if frame.buffer_size() != pixels * channels {
        return Err(Failed::decode("PNG", "its pixels don't match its size"));
    }
    if channels != 4 {
        widen(&mut buffer, pixels, channels);
    }
    buffer.truncate(pixels * 4);
    Raster::new(width, height, buffer)
}

/// RGB when every pixel is opaque, RGBA otherwise.
pub(crate) fn widen_rgb(buffer: &mut [u8], pixels: usize) {
    widen(buffer, pixels, 3);
}

pub fn encode(raster: &Raster, compression: png::Compression) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let opaque = raster.opaque();
    let rgb;
    let (color, data) = if opaque {
        rgb = raster.flatten([0, 0, 0]);
        (ColorType::Rgb, rgb.as_slice())
    } else {
        (ColorType::Rgba, raster.data.as_slice())
    };
    let mut encoder = png::Encoder::new(&mut out, raster.width, raster.height);
    encoder.set_color(color);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(compression);
    let encoding =
        |e: png::EncodingError| Failed::invalid(format!("The PNG could not be written: {e}"));
    let mut writer = encoder.write_header().map_err(encoding)?;
    writer.write_image_data(data).map_err(encoding)?;
    writer.finish().map_err(encoding)?;
    Ok(out)
}
