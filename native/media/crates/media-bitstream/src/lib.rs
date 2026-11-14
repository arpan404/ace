// SPDX-License-Identifier: Apache-2.0
//! Pure H.264 and H.265 bitstream work (docs/media/plan.md, "media-bitstream"): NAL framing,
//! parameter-set and slice-header writers with readers that round-trip them, and the
//! `avcC`/`hvcC` records of ISO/IEC 14496-15. Written from ITU-T H.264 and H.265.
//!
//! Readers accept the syntax ace's encoders and the platform encoders produce. Features no
//! encoder of ours emits (explicit scaling lists, slice groups, HRD in HEVC VUI, tiles,
//! long-term pictures, extensions)
//! are reported as [`BitstreamError::Unsupported`], never misread.
use std::fmt;

pub mod avcc;
pub mod bits;
pub mod h264;
pub mod hevc;
pub mod hvcc;
pub mod nal;
mod vui;
mod weights;

pub use bits::{BitReader, BitWriter};
pub use vui::{AspectRatio, Colour, VideoSignal};
pub use weights::{PredWeightTable, Weight};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BitstreamError {
    Truncated,
    Invalid(&'static str),
    Unsupported(&'static str),
}

impl fmt::Display for BitstreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("bitstream truncated"),
            Self::Invalid(what) => write!(f, "invalid bitstream: {what}"),
            Self::Unsupported(what) => write!(f, "unsupported bitstream feature: {what}"),
        }
    }
}

impl std::error::Error for BitstreamError {}

/// The RBSP of a NAL unit whose header is `header_len` bytes.
pub(crate) fn rbsp_of(nal: &[u8], header_len: usize) -> Result<Vec<u8>, BitstreamError> {
    let payload = nal.get(header_len..).ok_or(BitstreamError::Truncated)?;
    Ok(nal::unescape(payload))
}

/// A NAL unit (no start code) from a header and an RBSP.
pub(crate) fn nal_unit(header: &[u8], rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(header.len() + rbsp.len() + rbsp.len() / 64 + 1);
    out.extend_from_slice(header);
    nal::escape_into(rbsp, &mut out);
    out
}
