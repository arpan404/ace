// SPDX-License-Identifier: Apache-2.0
//! The libva shell. Every `unsafe` block calls into libva through [`api::Api`] or reads
//! memory libva mapped; each states what it relies on.
#![allow(unsafe_code)]
mod api;
mod device;
mod encoder;
mod ffi;
mod params;
mod surface;
mod vpp;

pub use api::LoadError;
pub use device::{Device, OpenError};
pub use encoder::{SessionInfo, VaEncoder};
pub use surface::{DmaBuf, DmaBufObject, DmaBufPlane, Surface, SurfacePool};
pub use vpp::VaScaler;
