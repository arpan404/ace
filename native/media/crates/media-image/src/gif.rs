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

/// The block structure (GIF89a §17–27) to its trailer, without decoding any frame: a file cut
/// after its first frame, or anywhere before the trailer, is cut.
fn whole(bytes: &[u8]) -> Result<()> {
    let truncated = || Failed::truncated("GIF");
    let table = |flags: u8| {
        if flags & 0x80 != 0 {
            3usize << ((flags & 7) + 1)
        } else {
            0
        }
    };
    let flags = *bytes.get(10).ok_or_else(truncated)?;
    let mut at = 13 + table(flags);
    // Data sub-blocks: a length byte and that many bytes, until a zero length.
    let sub_blocks = |mut at: usize| -> Result<usize> {
        loop {
            let length = usize::from(*bytes.get(at).ok_or_else(truncated)?);
            at += 1 + length;
            if length == 0 {
                return Ok(at);
            }
        }
    };
    loop {
        match bytes.get(at).copied().ok_or_else(truncated)? {
            0x3b => return Ok(()),
            0x21 => at = sub_blocks(at + 2)?,
            0x2c => {
                let flags = *bytes.get(at + 9).ok_or_else(truncated)?;
                // The descriptor, its local table, the LZW code size, then the image data.
                at = sub_blocks(at + 10 + table(flags) + 1)?;
            }
            _ => return Err(Failed::decode("GIF", "a block has no known introducer")),
        }
    }
}

pub fn header(bytes: &[u8]) -> Result<(u32, u32)> {
    whole(bytes)?;
    let decoder = options().read_info(bytes).map_err(failed)?;
    Ok((u32::from(decoder.width()), u32::from(decoder.height())))
}

pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<Raster> {
    whole(bytes)?;
    let mut decoder = options().read_info(bytes).map_err(failed)?;
    let (width, height) = (u32::from(decoder.width()), u32::from(decoder.height()));
    check_input(width, height, max_pixels)?;
    let (left, top, fw, fh) = {
        let frame = decoder
            .next_frame_info()
            .map_err(failed)?
            .ok_or_else(|| Failed::truncated("GIF"))?;
        (
            usize::from(frame.left),
            usize::from(frame.top),
            usize::from(frame.width),
            usize::from(frame.height),
        )
    };
    let (w, h) = (width as usize, height as usize);
    if decoder.buffer_size() != fw * fh * 4 {
        return Err(Failed::decode(
            "GIF",
            "its first frame doesn't match its size",
        ));
    }
    // A first frame covering the whole screen decodes straight into the picture: one buffer.
    if (left, top, fw, fh) == (0, 0, w, h) {
        let mut data = vec![0; w * h * 4];
        decoder.read_into_buffer(&mut data).map_err(failed)?;
        return Raster::new(width, height, data);
    }
    // A smaller one has a buffer of its own, drawn at its place on the transparent screen.
    let mut frame = vec![0; fw * fh * 4];
    decoder.read_into_buffer(&mut frame).map_err(failed)?;
    let mut canvas = Raster::filled(width, height, [0; 4]);
    for y in 0..fh.min(h.saturating_sub(top)) {
        let row = (fw).min(w.saturating_sub(left)) * 4;
        let from = y * fw * 4;
        let to = ((top + y) * w + left) * 4;
        canvas.data[to..to + row].copy_from_slice(&frame[from..from + row]);
    }
    Ok(canvas)
}
