// SPDX-License-Identifier: Apache-2.0
//! Media Foundation backend (ADR 0148): H.264/HEVC encode and decode through MFTs on a
//! shared D3D11 device, colour conversion and scaling with the D3D11 video processor, WIC
//! JPEG for stills, and the backend's bounded availability trial.
//!
//! Hardware MFTs come first; Microsoft's software MFT is the fallback and is reported as
//! not hardware. Pictures stay in D3D11 textures between steps on the hardware path; every
//! picture-sized copy between CPU and GPU is counted in [`Copies`].
pub mod color;
pub mod nal;
mod rank;
pub use rank::{Candidate, Vendor, order_encoders};

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

/// Picture-sized GPU→CPU readbacks and CPU→GPU uploads for one call. Encoded bitstreams
/// are not counted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Copies {
    pub readbacks: u32,
    pub uploads: u32,
}
