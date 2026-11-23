// SPDX-License-Identifier: Apache-2.0
//! The fact reducer (ADR 0223 §2, E4). E0 declares the modules; E4 ports the
//! `packages/core/src/` closure into them, one Rust module per TypeScript module
//! where that reads well. Pure: no I/O, no clock, no napi.

pub mod ace_tools;
pub mod background_hold;
pub mod cleanup;
pub mod deadlines;
pub mod diagnostics;
pub mod emit;
pub mod entities;
pub mod expiry_map;
pub mod external;
pub mod fact_data;
pub mod facts;
pub mod human;
pub mod indexes;
pub mod item_input;
pub mod items;
pub mod liveness;
pub mod output_snapshot;
pub mod reconciled_item;
pub mod reduce;
pub mod runs;
pub mod state;
pub mod status;
pub mod status_inputs;
pub mod tree;
pub mod validate;

pub use facts::{Fact, Key};
pub use state::ThreadState;
