// SPDX-License-Identifier: Apache-2.0
//! Pixels to the job's output format.
use crate::error::{Failed, Result};
use crate::limits::{MAX_OUTPUT_BYTES, check_output};
use crate::raster::Raster;
use media_codec::{CpuPicture, PixelFormat, Plane, Size};
use media_wire::image::{DoneFormat, ImageOutput};

/// Baseline JPEG quality bounds.
pub fn quality(quality: u8) -> Result<u8> {
    if (1..=100).contains(&quality) {
        Ok(quality)
    } else {
        Err(Failed::invalid(format!(
            "JPEG quality {quality} is outside 1 to 100."
        )))
    }
}

pub fn encode(raster: &Raster, output: &ImageOutput) -> Result<(DoneFormat, Vec<u8>)> {
    check_output(raster.width, raster.height)?;
    let (format, bytes) = match output {
        ImageOutput::Jpeg {
            quality: q,
            background,
        } => {
            let q = quality(*q)?;
            let rgb = raster.flatten(background.unwrap_or([0, 0, 0]));
            let picture = CpuPicture::new(
                Size {
                    width: raster.width,
                    height: raster.height,
                },
                PixelFormat::Rgb8,
                [Plane {
                    data: rgb,
                    stride: raster.width as usize * 3,
                }],
                0,
            )
            .map_err(|e| Failed::invalid(format!("The JPEG could not be written: {e}")))?;
            let mut out = Vec::new();
            let pixels = u64::from(raster.width) * u64::from(raster.height);
            crate::with_jpeg(pixels, |codec| codec.encode_into(&picture, q, &mut out))
                .map_err(|e| Failed::invalid(format!("The JPEG could not be written: {e}")))?;
            (DoneFormat::Jpeg, out)
        }
        ImageOutput::Rgba => (DoneFormat::Rgba, raster.data.clone()),
        ImageOutput::Png => (
            DoneFormat::Png,
            crate::png::encode(raster, png::Compression::Fast)?,
        ),
    };
    sized(format, bytes)
}

/// An output too large for one frame is refused.
pub fn sized(format: DoneFormat, bytes: Vec<u8>) -> Result<(DoneFormat, Vec<u8>)> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(Failed::too_large(format!(
            "The output is {} bytes, more than one message carries.",
            bytes.len()
        )));
    }
    Ok((format, bytes))
}
