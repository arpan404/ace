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
            bytes: 512 * 1024 * 1024,
        },
    );
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    Ok(decoder)
}

/// The stored size, from IHDR.
pub fn header(bytes: &[u8]) -> Result<(u32, u32)> {
    let mut decoder = reader(bytes)?;
    let info = decoder.read_header_info().map_err(failed)?;
    Ok((info.width, info.height))
}

pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<Raster> {
    let (width, height) = header(bytes)?;
    check_input(width, height, max_pixels)?;
    let mut reader = reader(bytes)?.read_info().map_err(failed)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| Failed::too_large("The PNG is too large to decode."))?;
    let mut buffer = vec![0; size];
    let frame = reader.next_frame(&mut buffer).map_err(failed)?;
    // The default image must be followed by IEND: a file cut after its pixels is still cut.
    reader.finish().map_err(failed)?;
    let pixels = width as usize * height as usize;
    let data = &buffer[..frame.buffer_size()];
    let rgba = match (frame.color_type, frame.bit_depth) {
        (ColorType::Rgba, BitDepth::Eight) => data.to_vec(),
        (ColorType::Rgb, BitDepth::Eight) => data
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        (ColorType::GrayscaleAlpha, BitDepth::Eight) => data
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        (ColorType::Grayscale, BitDepth::Eight) => {
            data.iter().flat_map(|&g| [g, g, g, 255]).collect()
        }
        (color, depth) => {
            return Err(Failed::decode(
                "PNG",
                format!("{color:?} at {depth:?} bits is not expanded to 8-bit"),
            ));
        }
    };
    if rgba.len() != pixels * 4 {
        return Err(Failed::decode("PNG", "its pixels don't match its size"));
    }
    Raster::new(width, height, rgba)
}

/// RGB when every pixel is opaque, RGBA otherwise.
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
