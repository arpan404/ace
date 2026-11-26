// SPDX-License-Identifier: Apache-2.0
//! Pi's session: the sans-IO wire core (E3-pi.1), its I/O shell (E3-pi.2), and the Rust
//! control composition E3-pi.3 builds for `ace-daemon-bin`: launch, spawn, lifecycle, resume,
//! model and effort selection, with the engine's session interface as the event sink.
//!
//! The composition ports `packages/adapter-pi/src/session.ts` (`openPiSession`) and the native
//! facade `native-session.ts`; every TypeScript name it replaces is named at its function.

pub mod command;
pub mod config;
pub mod control;
pub mod dialogs;
pub mod error;
pub mod history;
pub mod io;
pub mod launch;
pub mod redact;
pub mod reference;
pub mod resolve;
pub mod shell;
pub mod version;
pub mod wire;

pub use control::{
    MonotonicClock, PiClock, PiLease, PiSession, PiSessionError, PiSessionOpen, open_pi_session,
};
pub use error::{PiError, Refused, Uncertain};
pub use launch::{PiLaunch, PiLaunchInput, pi_launch, pi_launch_args};
pub use wire::{Effect, FrameDir, PiWire, PiWireConfig};
