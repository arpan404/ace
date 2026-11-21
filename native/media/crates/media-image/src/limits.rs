// SPDX-License-Identifier: Apache-2.0
//! Bounds every job has, whatever it asks for (ADR 0201 §5).
use crate::error::{Failed, Result};

/// Longest side an input may have.
pub const MAX_SIDE: u32 = 16_384;
/// Most pixels an input may have.
pub const MAX_PIXELS: u64 = 64 * 1024 * 1024;
/// Largest SVG text, and the longest side one is drawn at.
pub const SVG_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const SVG_MAX_SIDE: u32 = 4096;
/// Longest side of an output (the JPEG encoder's bound).
pub const OUTPUT_MAX_SIDE: u32 = media_codec::MAX_DIMENSION;
/// An output must fit one normal-lane frame with its JSON.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024 - 64 * 1024;

/// A stored size against the hard bounds and the job's `max_pixels`.
pub fn check_input(width: u32, height: u32, max_pixels: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(Failed::decode("image", "it has no pixels"));
    }
    let pixels = u64::from(width) * u64::from(height);
    if width > MAX_SIDE || height > MAX_SIDE || pixels > MAX_PIXELS {
        return Err(Failed::too_large(format!(
            "The image is {width} × {height}, past ace's {MAX_SIDE} px a side or 64 Mi pixels."
        )));
    }
    if pixels > u64::from(max_pixels) {
        return Err(Failed::too_large(format!(
            "The image is {width} × {height} ({pixels} pixels), more than the {max_pixels} allowed."
        )));
    }
    Ok(())
}

/// An output or canvas size.
pub fn check_output(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(Failed::invalid(
            "An output needs at least one pixel a side.",
        ));
    }
    if width > OUTPUT_MAX_SIDE || height > OUTPUT_MAX_SIDE {
        return Err(Failed::too_large(format!(
            "An output of {width} × {height} is past {OUTPUT_MAX_SIDE} px a side."
        )));
    }
    Ok(())
}
