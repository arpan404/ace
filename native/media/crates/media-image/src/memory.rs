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

/// What decoding an input holds: its RGBA bytes, its size and its longest side.
struct Decoded {
    bytes: u64,
    width: u64,
    height: u64,
    side: u64,
}

impl Decoded {
    /// The size it fits to inside `(w, h)`: never larger than itself (a vector is already at
    /// the size it is drawn at).
    fn fitted(&self, (w, h): (u32, u32)) -> (u32, u32) {
        let side = |n: u64| u32::try_from(n).unwrap_or(u32::MAX).max(1);
        crate::fit::inside(side(self.width), side(self.height), w, h, false)
    }
}

/// An input's decoded RGBA: its stored size, or for a vector what it may be drawn at. An icon is
/// charged for its largest entry: a decode may fall through to any of them.
fn decoded(input: &Input, max_pixels: u32, drawn: (u32, u32)) -> Result<Decoded> {
    let (w, h) = if let Input::Encoded(bytes) = input
        && crate::sniff::sniff(bytes) == Some(SourceFormat::Ico)
    {
        crate::ico::entries(bytes, 0)?
            .iter()
            .map(|e| (u64::from(e.width), u64::from(e.height)))
            .max_by_key(|(w, h)| w * h)
            .unwrap_or((0, 0))
    } else {
        let source = header(input, max_pixels)?;
        let stored = (u64::from(source.width), u64::from(source.height));
        if source.format == SourceFormat::Svg {
            let most = u64::from(SVG_MAX_SIDE);
            (
                u64::from(drawn.0).clamp(stored.0, most),
                u64::from(drawn.1).clamp(stored.1, most),
            )
        } else {
            stored
        }
    };
    Ok(Decoded {
        bytes: rgba(w * h),
        width: w,
        height: h,
        side: w.max(h),
    })
}

/// Scaling a picture with longest side `from` to fit `(w, h)`: the resampler's vertical pass
/// holds whole source rows at the output's height, then the output itself.
fn scaled(from: u64, (w, h): (u32, u32)) -> u64 {
    let out = u64::from(w.max(h)).min(from);
    rgba(from * out) + rgba(u64::from(w) * u64::from(h))
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
        ImageOp::Alpha { max_pixels } => decoded(first()?, *max_pixels, (0, 0))?.bytes * 5 / 4,
        ImageOp::Fit {
            max_pixels,
            width,
            height,
            ..
        } => {
            let input = decoded(first()?, *max_pixels, (*width, *height))?;
            let out = input.fitted((*width, *height));
            // The decoded input, the scaler's rows and output, then the turned copy of that
            // output and what the encoder makes of it.
            input.bytes + scaled(input.side, out) + rgba(pixels(out.0, out.1)) * 2
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
                    let drawn = (*width, *height);
                    let layer = decoded(nth(inputs, *input)?, *max_pixels, drawn)?;
                    let mut held = layer.bytes + scaled(layer.side, drawn);
                    if let Some(mask) = mask {
                        let mask = decoded(nth(inputs, *mask)?, *max_pixels, drawn)?;
                        held += mask.bytes + scaled(mask.side, drawn);
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
    use crate::ico::tests::{ico, png_header};
    use media_wire::image::ImageOutput;

    #[test]
    fn an_icon_is_reserved_for_its_largest_entry_whatever_the_box()
    -> std::result::Result<(), String> {
        let bytes = ico(&[(16, png_header(16, 16)), (0, png_header(2048, 2048))]);
        let op = ImageOp::Fit {
            max_pixels: 1 << 24,
            width: 16,
            height: 16,
            auto_orient: false,
            vector_scale: None,
            output: ImageOutput::Png,
        };
        let peak = peak_bytes(&[Input::Encoded(&bytes)], &op).map_err(|f| f.message)?;
        assert!(peak >= 2048 * 2048 * 4, "{peak}");
        Ok(())
    }

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
            // The 100 × 50 input, the scaler's 100-wide rows 10 high and its output, which fits
            // the 10 × 10 box at 10 × 5, then the turned and encoded copies of that output.
            100 * 50 * 4 + (100 * 10 * 4 + 10 * 5 * 4) + 10 * 5 * 4 * 2 + OVERHEAD
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
