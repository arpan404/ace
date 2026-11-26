// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools (docs/devices/porting-guide.md D5): typed decoding of their
//! arguments, their descriptors, and their results.
//!
//! `sim-schemas.ts`'s Zod decoding is replaced by [`args`], which accepts exactly
//! what the schemas accept and refuses the same values with the same public
//! `invalid_arguments` issues. The tool prose and the `sim-tools.ts` results are
//! [`describe`] and [`result`].

pub mod args;

pub use args::{Args, ArgumentError, Issue, SimTool, decode};
