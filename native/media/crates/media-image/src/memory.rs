// SPDX-License-Identifier: Apache-2.0
//! What a job will hold at its peak, from its inputs' headers alone, so the image threads can
//! reserve it from their shared budget before any pixel is decoded.
use crate::Input;
use crate::decode::header;
use crate::error::{Failed, Result};
use crate::limits::SVG_MAX_SIDE;
use media_wire::image::{ImageOp, Layer, SourceFormat};

/// Room for codec state, tables and the encoded output beside the pixels.
const OVERHEAD: u64 = 8 * 1024 * 1024;

fn rgba(pixels: u64) -> u64 {
    pixels.saturating_mul(4)
}

/// An input's decoded RGBA bytes: its stored size, or for a vector what it may be drawn at.
fn decoded(input: &Input, max_pixels: u32, drawn: u64) -> Result<u64> {
    let source = header(input, max_pixels)?;
    let stored = u64::from(source.width) * u64::from(source.height);
    let svg_most = u64::from(SVG_MAX_SIDE) * u64::from(SVG_MAX_SIDE);
    Ok(rgba(if source.format == SourceFormat::Svg {
        drawn.min(svg_most).max(stored)
    } else {
        stored
    }))
}

fn nth<'a, 'b>(inputs: &'a [Input<'b>], index: u32) -> Result<&'a Input<'b>> {
    inputs.get(index as usize).ok_or_else(|| {
        Failed::invalid(format!(
            "Layer input {index} isn't one of the job's inputs."
        ))
    })
}

/// Bytes the job may hold at once: decoded inputs, scaled copies and the canvas.
pub fn peak_bytes(inputs: &[Input], op: &ImageOp) -> Result<u64> {
    let first = || {
        inputs
            .first()
            .ok_or_else(|| Failed::invalid("The job has no input."))
    };
    let pixels = |w: u32, h: u32| u64::from(w) * u64::from(h);
    let peak = match op {
        ImageOp::Probe { .. } => 0,
        ImageOp::Alpha { max_pixels } => decoded(first()?, *max_pixels, 0)? * 5 / 4,
        ImageOp::Fit {
            max_pixels,
            width,
            height,
            ..
        } => {
            let out = pixels(*width, *height);
            // The decoded input, then its scaled copy and what the encoder makes of it.
            decoded(first()?, *max_pixels, out)? + rgba(out) * 2
        }
        ImageOp::Compose {
            width,
            height,
            max_pixels,
            layers,
            ..
        } => {
            let mut layer_peak = 0;
            for layer in layers {
                if let Layer::Image {
                    input,
                    width,
                    height,
                    mask,
                    ..
                } = layer
                {
                    let drawn = pixels(*width, *height);
                    let mut held = decoded(nth(inputs, *input)?, *max_pixels, drawn)? + rgba(drawn);
                    if let Some(mask) = mask {
                        held += decoded(nth(inputs, *mask)?, *max_pixels, drawn)? + rgba(drawn);
                    }
                    layer_peak = layer_peak.max(held);
                }
            }
            // Layers are drawn one at a time onto the canvas, which is then encoded.
            rgba(pixels(*width, *height)) * 2 + layer_peak
        }
    };
    Ok(peak + OVERHEAD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_wire::image::ImageOutput;

    #[test]
    fn a_fit_reserves_its_decoded_input_and_output_before_decoding()
    -> std::result::Result<(), String> {
        let rgba = vec![0u8; 100 * 50 * 4];
        let input = Input::Rgba {
            data: &rgba,
            width: 100,
            height: 50,
        };
        let op = ImageOp::Fit {
            max_pixels: 1 << 20,
            width: 10,
            height: 10,
            auto_orient: false,
            vector_scale: None,
            output: ImageOutput::Png,
        };
        assert_eq!(
            peak_bytes(&[input], &op).map_err(|f| f.message)?,
            100 * 50 * 4 + 10 * 10 * 4 * 2 + OVERHEAD
        );
        // A header past the job's bound is refused here, before any reservation.
        let tight = ImageOp::Alpha { max_pixels: 100 };
        assert_eq!(
            peak_bytes(&[input], &tight).err().map(|f| f.reason),
            Some(media_wire::image::ImageFailure::TooLarge)
        );
        Ok(())
    }
}
