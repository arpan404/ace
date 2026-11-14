// SPDX-License-Identifier: Apache-2.0
//! Linux VA-API backend (docs/media/plan.md, "Acceleration"; ADR 0148): H.264 and HEVC
//! encode through `VAEntrypointEncSliceLP`/`EncSlice` with ace's own packed headers, colour
//! conversion and scaling through VA-VPP, DMA-BUF import as VA surfaces, JPEG decode and
//! encode where the driver lists them, and the probe's availability trial.
//!
//! `libva.so.2` and `libva-drm.so.2` are opened at run time, never linked; on a machine
//! without them the backend reports nothing. Written from `va.h`, `va_enc_h264.h`,
//! `va_enc_hevc.h`, `va_enc_jpeg.h`, `va_dec_jpeg.h`, `va_vpp.h` and `va_drmcommon.h`.
//!
//! The decision logic (formats, levels, profile and rate-control choice, parameter sets,
//! picture sequencing, JPEG headers) is pure and builds on every platform; the libva shell
//! builds on Linux only.
pub mod formats;
pub mod jpeg;
pub mod levels;
pub mod plan;
pub mod select;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
