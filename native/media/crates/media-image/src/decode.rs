// SPDX-License-Identifier: Apache-2.0
//! One input to pixels: sniffed, bounded, decoded. Raster formats decode at their own size;
//! an SVG is drawn at the size the job's target asks for.
use crate::error::{Failed, Result};
use crate::limits::{SVG_MAX_SIDE, check_input};
use crate::raster::Raster;
use crate::svg::Svg;
use crate::{Input, ico, jpeg, sniff};
use media_wire::image::{ImageFailure, SourceFormat, SourceImage};

/// How a vector input is drawn (raster inputs ignore it, but an icon picks its entry by it).
#[derive(Clone, Copy, Debug)]
pub enum Target {
    /// Fit inside the box at up to `scale` pixels per unit.
    Fit { width: u32, height: u32, scale: f64 },
    /// Stretched to exactly this size.
    Exact { width: u32, height: u32 },
    /// At one pixel per unit.
    Natural,
}

impl Target {
    pub(crate) fn icon_width(self) -> u32 {
        match self {
            Self::Fit { width, height, .. } | Self::Exact { width, height } => width.max(height),
            Self::Natural => 256,
        }
    }
}

pub struct Decoded {
    pub raster: Raster,
    pub source: SourceImage,
}

fn source(format: SourceFormat, width: u32, height: u32, orientation: u8) -> SourceImage {
    SourceImage {
        format,
        width,
        height,
        orientation,
    }
}

fn unsupported() -> Failed {
    Failed::new(
        ImageFailure::Unsupported,
        "The bytes are not a JPEG, PNG, WebP, GIF, ICO or SVG image.",
    )
}

/// The stored size, format and orientation, without decoding pixels where the format allows.
pub fn header(input: &Input, max_pixels: u32) -> Result<SourceImage> {
    let bytes = match input {
        Input::Rgba {
            width,
            height,
            data,
            ..
        } => {
            check_input(*width, *height, max_pixels)?;
            if data.len() != *width as usize * *height as usize * 4 {
                return Err(Failed::invalid(
                    "The RGBA input's length doesn't match its size.",
                ));
            }
            return Ok(source(SourceFormat::Rgba, *width, *height, 1));
        }
        Input::Encoded(bytes) => bytes,
    };
    let format = sniff::sniff(bytes).ok_or_else(unsupported)?;
    let (width, height, orientation) = match format {
        SourceFormat::Jpeg => {
            let h = jpeg::scan(bytes)?;
            (h.width, h.height, h.orientation)
        }
        SourceFormat::Png => {
            let (w, h) = crate::png::header(bytes)?;
            (w, h, 1)
        }
        SourceFormat::Webp => {
            let (w, h) = crate::webp::header(bytes)?;
            (w, h, 1)
        }
        SourceFormat::Gif => {
            let (w, h) = crate::gif::header(bytes)?;
            (w, h, 1)
        }
        SourceFormat::Ico => {
            // The entry a natural-size decode starts with, from its own header.
            let first = ico::entries(bytes, Target::Natural.icon_width())?;
            let entry = first.first().ok_or_else(|| Failed::truncated("ICO"))?;
            (entry.width, entry.height, 1)
        }
        SourceFormat::Svg => {
            let (w, h) = Svg::parse(bytes)?.pixels(1.0);
            (w, h, 1)
        }
        SourceFormat::Rgba => return Err(unsupported()),
    };
    check_input(width, height, max_pixels)?;
    Ok(source(format, width, height, orientation))
}

pub fn decode(input: &Input, target: Target, max_pixels: u32) -> Result<Decoded> {
    let bytes = match input {
        Input::Rgba {
            width,
            height,
            data,
        } => {
            let source = header(input, max_pixels)?;
            return Ok(Decoded {
                raster: Raster::new(*width, *height, data.to_vec())?,
                source,
            });
        }
        Input::Encoded(bytes) => *bytes,
    };
    let format = sniff::sniff(bytes).ok_or_else(unsupported)?;
    let (raster, orientation) = match format {
        SourceFormat::Jpeg => {
            let h = jpeg::scan(bytes)?;
            check_input(h.width, h.height, max_pixels)?;
            (jpeg::decode(bytes, h)?, h.orientation)
        }
        SourceFormat::Png => (crate::png::decode(bytes, max_pixels)?, 1),
        SourceFormat::Webp => (crate::webp::decode(bytes, max_pixels)?, 1),
        SourceFormat::Gif => (crate::gif::decode(bytes, max_pixels)?, 1),
        SourceFormat::Ico => (icon(bytes, target, max_pixels)?, 1),
        SourceFormat::Svg => {
            let svg = Svg::parse(bytes)?;
            let (width, height) = svg_size(&svg, target)?;
            check_input(width, height, max_pixels)?;
            let (w, h) = svg.pixels(1.0);
            return Ok(Decoded {
                raster: svg.render(width, height)?,
                source: source(format, w, h, 1),
            });
        }
        SourceFormat::Rgba => return Err(unsupported()),
    };
    let source = source(format, raster.width, raster.height, orientation);
    Ok(Decoded { raster, source })
}

/// The size an SVG is drawn at for `target`, refused past what may be drawn: the one rule both
/// the decode and its memory reservation use.
pub(crate) fn svg_size(svg: &Svg, target: Target) -> Result<(u32, u32)> {
    let (width, height) = match target {
        Target::Exact { width, height } => (width, height),
        Target::Natural => svg.pixels(1.0),
        Target::Fit {
            width,
            height,
            scale,
        } => {
            let (w, h) = svg.size();
            let ratio = (f64::from(width) / w).min(f64::from(height) / h).min(scale);
            svg.pixels(ratio)
        }
    };
    if width > SVG_MAX_SIDE || height > SVG_MAX_SIDE {
        return Err(Failed::too_large(format!(
            "An SVG drawn at {width} × {height} is past {SVG_MAX_SIDE} px a side."
        )));
    }
    Ok((width, height))
}

/// The icon entry closest to the target's width, as pixels.
fn icon(bytes: &[u8], target: Target, max_pixels: u32) -> Result<Raster> {
    let mut last = None;
    for entry in ico::entries(bytes, target.icon_width())? {
        // Each entry is checked at the size its own header gives, before it is decoded.
        if let Err(failed) = check_input(entry.width, entry.height, max_pixels) {
            last = Some(failed);
            continue;
        }
        let raster = if entry.png() {
            crate::png::decode(entry.image, max_pixels)
        } else {
            ico::bitmap(entry.image).ok_or_else(|| {
                Failed::new(
                    ImageFailure::Unsupported,
                    "The icon's bitmaps are palette images, which ace doesn't draw.",
                )
            })
        };
        match raster {
            Ok(raster) if (raster.width, raster.height) == (entry.width, entry.height) => {
                return Ok(raster);
            }
            Ok(_) => {
                last = Some(Failed::decode(
                    "ICO",
                    "an entry decodes to a size other than its header's",
                ));
            }
            Err(failed) => last = Some(failed),
        }
    }
    Err(last.unwrap_or_else(|| Failed::truncated("ICO")))
}
