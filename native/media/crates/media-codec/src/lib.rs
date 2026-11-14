// SPDX-License-Identifier: Apache-2.0
//! Hardware-independent codec contracts. All timestamps are supplied by the caller.
mod buffers;
mod contract;
mod workers;
pub use buffers::{BufferPool, PooledBuffer};
pub use workers::{
    RejectedStill, StillFactory, StillResult, StillWorkers, WorkerClock, WorkerLimits,
};
pub mod fake;
mod jpeg;
#[cfg(target_os = "macos")]
mod macos;
mod picture;
mod still;
pub use jpeg::{CpuJpegCodec, jpeg_size};
#[cfg(target_os = "macos")]
pub use macos::{MacJpegCodec, NativeJpegPicture};

pub use contract::*;
pub use picture::*;
pub use still::{CpuScaler, fit_size, fit_size_with_max_pixels};

/// The portable SIMD CPU fallback. Hardware selection belongs to the probe.
pub fn default_still_codec() -> Box<dyn StillCodec> {
    Box::<CpuJpegCodec>::default()
}
