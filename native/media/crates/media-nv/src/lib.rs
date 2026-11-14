// SPDX-License-Identifier: Apache-2.0
//! NVIDIA hardware video: NVENC encode and NVDEC decode of H.264 and HEVC (ADR 0148).
//!
//! The driver's own libraries are opened at run time (`libnvidia-encode.so.1`,
//! `libnvcuvid.so.1`, `libcuda.so.1` on Linux; `nvEncodeAPI64.dll`, `nvcuvid.dll`,
//! `nvcuda.dll` on Windows). ace links nothing from NVIDIA and ships nothing of NVIDIA's.
//! The interface types are our own, for one pinned API version (NVENC 12.0). On other
//! platforms this crate is empty.
#![cfg(any(target_os = "linux", windows))]

/// Marks plain-data FFI structures as safe to create zeroed.
macro_rules! pod {
    ($($t:ty),* $(,)?) => { $(
        // SAFETY: the type holds only integers, raw pointers and `Option` of function pointers.
        #[allow(unsafe_code)]
        unsafe impl $crate::enc_abi::Pod for $t {}
    )* };
}

mod cuda;
mod dec_abi;
mod decoder;
mod enc_abi;
mod encoder;
mod error;
#[cfg(test)]
mod fake;
mod load;
mod probe;
mod session;
mod surface;
#[cfg(test)]
mod tests;

pub use decoder::NvDecoder;
pub use encoder::{NvEncoder, Preset};
pub use load::{NvRuntime, OPT_IN_VAR, UNVERIFIED_LAYOUT};
pub use probe::{NvProbe, ProbeEntry, ProbeOutcome, ProbeStep, probe};
pub use surface::{D3d11Texture, GlTexture};

/// The NVENC API version this build is written for, as `(major, minor)`.
pub const PINNED_API: (u32, u32) = (enc_abi::API_MAJOR, enc_abi::API_MINOR);
