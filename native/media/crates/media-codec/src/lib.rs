// SPDX-License-Identifier: Apache-2.0
//! Hardware-independent codec contracts. All timestamps are supplied by the caller.
mod contract;
pub mod fake;
mod picture;
mod still;

pub use contract::*;
pub use picture::*;
pub use still::{CpuScaler, JpegCodec, fit_size, fit_size_with_max_pixels};
