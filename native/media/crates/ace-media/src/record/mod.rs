// SPDX-License-Identifier: Apache-2.0
//! Recordings as fragmented MP4, written straight from the encoded stream with no re-encode
//! (ADR 0147 §6). [`assemble`] decides parts and fragments with no I/O; [`files`] writes them;
//! [`recover`] makes what a crash left playable.
pub mod assemble;
pub mod files;
pub mod opus;
pub mod recover;
pub mod video;

pub use files::Mp4Recorders;
