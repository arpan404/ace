// SPDX-License-Identifier: Apache-2.0
//! `recording-limits.ts`: the two caps a device recording keeps, shared by the recording
//! capture and ace-media's writer.

/// The most one device recording holds, across its parts.
pub const DEVICE_RECORDING_LIMIT: u64 = 512 * 1024 * 1024;

/// The most one MP4 part ace-media writes holds before it starts the next.
pub const DEVICE_RECORDING_PART_BYTES: u64 = 64 * 1024 * 1024;
