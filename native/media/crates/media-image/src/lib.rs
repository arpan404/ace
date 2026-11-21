// SPDX-License-Identifier: Apache-2.0
//! One-shot still images for ace-media (ADR 0201): probe, fit, alpha and compose over JPEG,
//! PNG, WebP, GIF, ICO, SVG and raw RGBA inputs, with bounds checked before pixels are
//! decoded and every refusal given a reason. Pure: no files, threads or clocks; the caller
//! reads file inputs and says when the deadline has passed.
mod compose;
mod decode;
mod encode;
mod error;
mod exif;
mod fit;
mod font;
mod gif;
mod ico;
mod jpeg;
mod limits;
mod png;
mod raster;
mod sniff;
mod svg;
mod webp;

pub use error::{Failed, ImageFailure, Result};
pub use limits::{MAX_OUTPUT_BYTES, MAX_PIXELS, MAX_SIDE};
pub use raster::Raster;

use decode::Target;
use media_codec::{CpuJpegCodec, Size};
use std::cell::RefCell;

thread_local! {
    /// Each image thread keeps one JPEG codec, so a repeated geometry reuses its buffers.
    static JPEG: RefCell<CpuJpegCodec> = RefCell::new(CpuJpegCodec::default());
}

/// `f` with this thread's JPEG codec.
pub(crate) fn with_jpeg<T>(f: impl FnOnce(&mut CpuJpegCodec) -> T) -> T {
    JPEG.with(|codec| f(&mut codec.borrow_mut()))
}
use media_wire::image::{DoneFormat, ImageOp, ImageOutput, SourceFormat, SourceImage};

/// One input's bytes, as the caller has them.
#[derive(Clone, Copy, Debug)]
pub enum Input<'a> {
    /// An encoded image; its format is sniffed.
    Encoded(&'a [u8]),
    /// Straight RGBA, 4 bytes a pixel.
    Rgba {
        data: &'a [u8],
        width: u32,
        height: u32,
    },
}

/// A job's result: `image.done`'s fields and payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Done {
    pub width: u32,
    pub height: u32,
    pub format: DoneFormat,
    pub source: SourceImage,
    pub bytes: Vec<u8>,
}

/// An input's pixels at its own size (an SVG at one pixel per unit), as stored: not turned.
pub fn pixels(input: &Input, max_pixels: u32) -> Result<Raster> {
    Ok(decode::decode(input, Target::Natural, max_pixels)?.raster)
}

/// Most layers a composite draws.
const MAX_LAYERS: usize = 256;

/// Runs `op` over `inputs`. `expired` is asked between steps; once it says yes the job stops
/// with `deadline`.
pub fn run(inputs: &[Input], op: &ImageOp, expired: &dyn Fn() -> bool) -> Result<Done> {
    let step = || {
        if expired() {
            Err(Failed::new(
                ImageFailure::Deadline,
                "The image job ran past its deadline.",
            ))
        } else {
            Ok(())
        }
    };
    let first = || {
        inputs
            .first()
            .ok_or_else(|| Failed::invalid("The job has no input."))
    };
    match op {
        ImageOp::Probe { max_pixels } => {
            let source = decode::header(first()?, *max_pixels)?;
            Ok(Done {
                width: source.width,
                height: source.height,
                format: DoneFormat::None,
                source,
                bytes: Vec::new(),
            })
        }
        ImageOp::Alpha { max_pixels } => {
            let decoded = decode::decode(first()?, Target::Natural, *max_pixels)?;
            step()?;
            let (format, bytes) = encode::sized(DoneFormat::Alpha, decoded.raster.alpha())?;
            Ok(Done {
                width: decoded.raster.width,
                height: decoded.raster.height,
                format,
                source: decoded.source,
                bytes,
            })
        }
        ImageOp::Fit {
            max_pixels,
            width,
            height,
            auto_orient,
            vector_scale,
            output,
        } => {
            limits::check_output(*width, *height)?;
            let scale = vector_scale.unwrap_or(1.0);
            if !(scale.is_finite() && scale > 0.0 && scale <= 64.0) {
                return Err(Failed::invalid(
                    "vectorScale must be above 0 and at most 64.",
                ));
            }
            let input = first()?;
            let fitting = Fitting {
                max_pixels: *max_pixels,
                width: *width,
                height: *height,
                auto_orient: *auto_orient,
            };
            if let Some(done) = planar_jpeg(input, &fitting, output)? {
                return Ok(done);
            }
            let target = Target::Fit {
                width: *width,
                height: *height,
                scale,
            };
            let decoded = decode::decode(input, target, *max_pixels)?;
            step()?;
            let mut raster = decoded.raster;
            if *auto_orient {
                raster = raster.orient(decoded.source.orientation);
            }
            let (w, h) = fit::inside(raster.width, raster.height, *width, *height, false);
            let raster = raster.resize(w, h)?;
            step()?;
            let (format, bytes) = encode::encode(&raster, output)?;
            Ok(Done {
                width: w,
                height: h,
                format,
                source: decoded.source,
                bytes,
            })
        }
        ImageOp::Compose {
            width,
            height,
            background,
            max_pixels,
            layers,
            output,
        } => {
            if layers.len() > MAX_LAYERS {
                return Err(Failed::invalid(format!(
                    "A composite has at most {MAX_LAYERS} layers."
                )));
            }
            let mut canvas = compose::Canvas::new(*width, *height, *background, *max_pixels)?;
            for layer in layers {
                step()?;
                canvas.layer(inputs, layer, *max_pixels)?;
            }
            let raster = canvas.finish()?;
            step()?;
            let (format, bytes) = encode::encode(&raster, output)?;
            Ok(Done {
                width: *width,
                height: *height,
                format,
                source: SourceImage {
                    format: SourceFormat::Rgba,
                    width: *width,
                    height: *height,
                    orientation: 1,
                },
                bytes,
            })
        }
    }
}

struct Fitting {
    max_pixels: u32,
    width: u32,
    height: u32,
    auto_orient: bool,
}

/// A JPEG to JPEG fit that needs no turn stays in YCbCr through M5's planar transcode.
/// `None` when the job isn't one, or the planar path doesn't take the stream (the general
/// path then answers, with its own reasons).
fn planar_jpeg(input: &Input, fitting: &Fitting, output: &ImageOutput) -> Result<Option<Done>> {
    let (Input::Encoded(bytes), ImageOutput::Jpeg { quality, .. }) = (input, output) else {
        return Ok(None);
    };
    if sniff::sniff(bytes) != Some(SourceFormat::Jpeg) {
        return Ok(None);
    }
    let header = jpeg::scan(bytes)?;
    limits::check_input(header.width, header.height, fitting.max_pixels)?;
    if fitting.auto_orient && header.orientation != 1 {
        return Ok(None);
    }
    let quality = encode::quality(*quality)?;
    let (w, h) = fit::inside(
        header.width,
        header.height,
        fitting.width,
        fitting.height,
        false,
    );
    let mut out = Vec::new();
    let target = Size {
        width: w,
        height: h,
    };
    if with_jpeg(|codec| codec.transcode_into(bytes, target, quality, &mut out)).is_err() {
        return Ok(None);
    }
    let (format, bytes) = encode::sized(DoneFormat::Jpeg, out)?;
    Ok(Some(Done {
        width: w,
        height: h,
        format,
        source: SourceImage {
            format: SourceFormat::Jpeg,
            width: header.width,
            height: header.height,
            orientation: header.orientation,
        },
        bytes,
    }))
}
