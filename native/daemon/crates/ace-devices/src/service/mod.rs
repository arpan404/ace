// SPDX-License-Identifier: Apache-2.0
//! The device service (`docs/devices/porting-guide.md` D4, `packages/devices/src/service`):
//! who controls a device, what work a control owns, and the two rules every other
//! part asks it (behaviour.md §3): an agent never acts on a device it doesn't
//! hold, and a person's takeover invalidates every pending agent command.
//!
//! Sans-IO: the clock is a parameter, never a global, and nothing here awaits.

pub mod held_pushes;
pub mod input_queue;
pub mod lease;
pub mod queue;
pub mod wire;
pub mod words;

pub use held_pushes::{Held, HeldPushes};
pub use input_queue::{Admission, MAX_PENDING_PER_KIND, PendingInput, SharedInput};
pub use lease::{
    Actor, ActorKind, Controller, ControllerLease, Holder, LeaseStatus, LeaseWatch, Retained,
    WatchStep, agent_owner,
};
pub use queue::{DeviceQueue, Finished, Kind, Run, SUPERSEDED, Started};
