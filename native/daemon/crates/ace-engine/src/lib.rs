// SPDX-License-Identifier: Apache-2.0
//! The daemon's engine (ADR 0223 §2, E5). E5.1 ports the facade's machinery first: the local
//! executor, the ports, the registry view, the intent workers, the limits, the store seam with
//! its after-commit wakes, and `ready`/`flush`/`close` with every public method declared at its
//! final timing. E5.2 to E5.10 fill in the modules behind these seams.

pub use futures;

pub mod access;
pub mod actor;
pub mod approvals;
mod close;
pub mod commands;
mod core;
pub mod cursor_reconcile;
pub mod delegation;
pub mod delivery;
mod engine;
mod error;
pub mod executor;
pub mod frames;
pub mod hosts;
pub mod inputs;
pub mod intents;
pub mod limits;
pub mod liveness;
pub mod meters;
pub mod models;
pub mod moves;
pub mod open;
pub mod ports;
pub mod queue;
pub mod records;
pub mod recovery;
pub mod registry;
pub mod release;
pub mod repository;
pub mod restart;
pub mod rules;
pub mod sessions;
pub mod settle;
pub mod snapshot;
mod state;
pub mod steering;
mod store;
pub mod transitions;
pub mod workers;

pub use core::Core;
pub use engine::Engine;
pub use error::{EngineError, Lifecycle};
pub use state::{EngineStack, FlushDepth, Inputs, State};
pub use store::{EngineStore, Tx};

/// The engine's thread ids are the protocol's strings.
pub type ThreadId = String;

/// The close deadline: the daemon's forced stop ends at 3.5 s (3 s polite + 0.5 s grace), plus
/// 1 s for the exits to be reaped and the final batches to commit, inside the 6 s cleanup budget.
pub const CLOSE_DEADLINE_MS: f64 = 4_500.0;

/// The idle sweep's period (`index.ts:146`).
pub const SWEEP_PERIOD_MS: f64 = 30_000.0;
