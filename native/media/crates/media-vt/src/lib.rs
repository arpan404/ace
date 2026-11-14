// SPDX-License-Identifier: Apache-2.0
//! VideoToolbox backend (ADR 0148): H.264/HEVC encode and decode, scaling with
//! `VTPixelTransferSession`, JPEG through VideoToolbox where its sessions report
//! hardware, and the backend's bounded availability trial.
//!
//! Pictures stay in IOSurface-backed `CVPixelBuffer`s ([`VtSurface`]) between
//! steps. A CPU picture costs one upload, counted per call so a source can
//! report its `uploads` and `readbacks` truthfully.
#[cfg(target_os = "macos")]
mod cf;
#[cfg(target_os = "macos")]
mod decoder;
#[cfg(target_os = "macos")]
mod encoder;
#[cfg(target_os = "macos")]
mod jpeg;
#[cfg(target_os = "macos")]
mod output;
#[cfg(target_os = "macos")]
mod probe;
#[cfg(target_os = "macos")]
mod surface;
#[cfg(target_os = "macos")]
mod transcode;
#[cfg(target_os = "macos")]
mod transfer;

#[cfg(target_os = "macos")]
pub use decoder::{DecodeOutput, VtDecoder};
#[cfg(target_os = "macos")]
pub use encoder::VtEncoder;
#[cfg(target_os = "macos")]
pub use jpeg::{JpegPath, VtJpeg};
#[cfg(target_os = "macos")]
pub use probe::{ProbeCancel, ProbeOptions, ProbeReport, TrialInput, probe};
#[cfg(target_os = "macos")]
pub use surface::{PixelPool, VtFormat, VtSurface, read_back, read_back_into};
#[cfg(target_os = "macos")]
pub use transcode::VtTranscoder;
#[cfg(target_os = "macos")]
pub use transfer::VtScaler;

/// Where a picture came from for one call: picture-sized GPU→CPU readbacks and
/// CPU→GPU uploads. Encoded bitstreams are not counted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Copies {
    pub readbacks: u32,
    pub uploads: u32,
}
