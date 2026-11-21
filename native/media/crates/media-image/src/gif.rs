// SPDX-License-Identifier: Apache-2.0
//! GIF: the first frame, drawn at its place on the logical screen.
use crate::error::{Failed, Result};
use crate::limits::check_input;
use crate::raster::Raster;
use gif::{ColorOutput, DecodeOptions, DecodingError};

fn failed(error: DecodingError) -> Failed {
    match error {
        DecodingError::UnexpectedEof => Failed::truncated("GIF"),
        DecodingError::Io(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            Failed::truncated("GIF")
        }
        other => Failed::decode("GIF", other),
    }
}

fn options() -> DecodeOptions {
    let mut options = DecodeOptions::new();
    options.set_color_output(ColorOutput::RGBA);
    options.check_frame_consistency(true);
    options
}

pub fn header(bytes: &[u8]) -> Result<(u32, u32)> {
    let decoder = options().read_info(bytes).map_err(failed)?;
    Ok((u32::from(decoder.width()), u32::from(decoder.height())))
}

pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<Raster> {
    let mut decoder = options().read_info(bytes).map_err(failed)?;
    let (width, height) = (u32::from(decoder.width()), u32::from(decoder.height()));
    check_input(width, height, max_pixels)?;
    let frame = decoder
        .read_next_frame()
        .map_err(failed)?
        .ok_or_else(|| Failed::truncated("GIF"))?;
    let mut canvas = Raster::filled(width, height, [0; 4]);
    let (fw, fh) = (usize::from(frame.width), usize::from(frame.height));
    if frame.buffer.len() != fw * fh * 4 {
        return Err(Failed::decode(
            "GIF",
            "its first frame doesn't match its size",
        ));
    }
    for y in 0..fh {
        let cy = usize::from(frame.top) + y;
        if cy >= height as usize {
            break;
        }
        for x in 0..fw {
            let cx = usize::from(frame.left) + x;
            if cx >= width as usize {
                break;
            }
            let from = (y * fw + x) * 4;
            let to = (cy * width as usize + cx) * 4;
            canvas.data[to..to + 4].copy_from_slice(&frame.buffer[from..from + 4]);
        }
    }
    Ok(canvas)
}
