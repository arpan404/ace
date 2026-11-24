// SPDX-License-Identifier: Apache-2.0
//! The Pi session's sans-IO wire core (E3-pi.1) and its I/O shell (E3-pi.2).
//! The shell owns the lock, the clock, the timers and the child process.

pub mod dialogs;
pub mod error;
pub mod io;
pub mod redact;
pub mod wire;

pub use error::{PiError, Refused, Uncertain};
pub use wire::{Effect, FrameDir, PiWire, PiWireConfig};
