// SPDX-License-Identifier: Apache-2.0
//! The Windows implementation. Every unsafe block calls a Media Foundation, D3D11, DXGI or
//! WIC function as Microsoft documents it; the `SAFETY` notes say what each relies on.
#![allow(unsafe_code)]
mod com;
mod decoder;
mod device;
mod encoder;
mod mft;
mod probe;
mod session;
mod surface;
mod variant;
mod vp;
mod wic;

pub use decoder::{DecodeOutput, MfDecoder};
pub use device::{Adapter, MfDevice};
pub use encoder::MfEncoder;
pub use probe::{ProbeCancel, ProbeOptions, ProbeReport, TrialInput, probe};
pub use surface::{MfFormat, MfSurface, read_back, upload};
pub use vp::MfScaler;
pub use wic::WicJpeg;
