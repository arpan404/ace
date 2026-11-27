// SPDX-License-Identifier: Apache-2.0
//! The daemon's own threads (E5.7): host threads Spade's MCP calls act in (`host-threads.ts`)
//! and guest threads that hold remote tool use (`guest-threads.ts`). Neither runs a provider
//! session here; `createEngineThread` is E5.4e/f's and comes in as the injected creation step.

pub mod guest;
pub mod host;

pub use guest::{GuestCommand, GuestHold, GuestInfo, GuestThreadInput, GuestThreads};
pub use host::{HostThreadInput, HostThreads, open_host_interaction, post_host_notice};
