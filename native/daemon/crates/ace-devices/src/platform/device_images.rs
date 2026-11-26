// SPDX-License-Identifier: Apache-2.0
//! `device-images.ts`'s bounds: every device picture ace-media makes has a deadline, so a device
//! call never waits on the pipeline past it. The shell takes both from [`super::device_images`]'
//! export, which is why they live here rather than in TypeScript.

/// A screenshot an agent waits on.
pub const SHOT_DEADLINE_MS: u64 = 10_000;

/// A look that is drawn once and cached.
pub const LOOK_DEADLINE_MS: u64 = 15_000;
