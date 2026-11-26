// SPDX-License-Identifier: Apache-2.0

//! The person's screen sessions, as they come off the helper (`packages/screen/src/`): the
//! frame wire and its pictures (`frames.ts`, `frame-picture.ts`), bounded delivery
//! (`frame-hub.ts`), and the shutdown failure the manager reports (`shutdown-failure.ts`).

pub mod frame_hub;
pub mod frame_picture;
pub mod frames;
pub mod physical_input;
pub mod shutdown_failure;
