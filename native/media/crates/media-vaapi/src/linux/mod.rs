// SPDX-License-Identifier: Apache-2.0
//! The libva shell. Every `unsafe` block calls into libva through [`api::Api`] or reads
//! memory libva mapped; each states what it relies on.
#![allow(unsafe_code)]
mod api;
mod device;
mod encoder;
#[cfg(test)]
mod fake;
mod ffi;
mod jpeg_hw;
mod params;
mod probe;
mod surface;
#[cfg(test)]
mod tests;
mod vpp;

pub use api::LoadError;
pub use device::{Device, OpenError};
pub use encoder::{SessionInfo, VaEncoder};
pub use jpeg_hw::VaJpegCodec;
pub use probe::{H264_CODEC, HEVC_CODEC, run_trial, trial_on, trial_steps};
pub use surface::{DmaBuf, DmaBufObject, DmaBufPlane, Surface, SurfacePool};
pub use vpp::VaScaler;
