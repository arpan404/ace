// SPDX-License-Identifier: Apache-2.0
//! The Pi session's sans-IO wire core (E3-pi.1). The I/O shell lands in
//! E3-pi.2 and owns the lock, the clock, the timers and the child process.

pub mod dialogs;
pub mod error;
pub mod redact;
pub mod wire;

pub use error::{PiError, Refused, Uncertain};
pub use wire::{Effect, FrameDir, PiWire, PiWireConfig};
