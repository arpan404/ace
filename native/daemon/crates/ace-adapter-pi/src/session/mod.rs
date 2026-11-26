// SPDX-License-Identifier: Apache-2.0
//! Pi's session: the sans-IO wire core (E3-pi.1), its I/O shell (E3-pi.2), and the Rust control
//! composition E3-pi.3 builds for `ace-daemon-bin`.
//!
//! Modules, one responsibility each: `wire` frames and inspects; `io` wires the wire to the
//! child's pipes and the engine's queue; `shell` spawns, stops and kills the child's group;
//! `open` composes the open; `inner` holds the session's state and the drainer; `methods`
//! implements `Session`; `launch`, `config`, `reference`, `version`, `command`, `resolve` and
//! `history` are the pieces those use. `clock` and `signal` are the injected clock and abort.

pub mod clock;
pub mod command;
pub mod config;
pub mod dialogs;
pub mod error;
pub mod history;
pub mod inner;
pub mod io;
pub mod launch;
pub mod lease;
pub mod methods;
pub mod open;
pub mod redact;
pub mod reference;
pub mod resolve;
pub mod shell;
pub mod signal;
pub mod version;
pub mod wire;

pub use clock::{Clock, ManualTimer, MonotonicClock, Timer, TokioTimer};
pub use error::{PiError, Refused, Uncertain};
pub use launch::{PiLaunch, PiLaunchInput, pi_launch, pi_launch_args};
pub use lease::{LeaseGuard, PiLease};
pub use methods::PiSession;
pub use open::{PiSessionError, PiSessionOpen, open_pi_session};
pub use signal::Abort;
pub use wire::{Effect, FrameDir, PiWire, PiWireConfig};
