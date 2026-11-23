// SPDX-License-Identifier: Apache-2.0
//! The fact reducer (ADR 0223 §2, E4). Ports the `packages/core/src/`
//! closure, one Rust module per TypeScript module. Pure: no I/O, no clock,
//! no napi. All JSON parsing and emitting goes through `json_io`, so the
//! eventual `ace-json` switch touches one module.

pub mod ace_tools;
pub mod background_hold;
pub mod cleanup;
pub mod deadlines;
pub mod delta_text;
pub mod diagnostics;
pub mod emit;
pub mod entities;
pub mod entity_model;
pub mod error;
pub mod expiry_map;
pub mod external;
pub mod fact_data;
pub mod facts;
pub mod human;
pub mod indexes;
pub mod item_input;
pub mod item_meta;
pub mod item_model;
pub mod items;
pub mod json_io;
pub mod liveness;
pub mod output_snapshot;
pub mod reconciled_item;
pub mod reduce;
pub mod runs;
pub mod state;
pub mod status;
pub mod status_inputs;
pub mod status_resolve;
pub mod thread_status;
pub mod tree;
pub mod validate;
pub mod validate_items;
pub mod validate_shapes;
pub mod validate_unknown;

pub use error::CoreError;
pub use facts::{Fact, Key};
pub use state::ThreadState;
