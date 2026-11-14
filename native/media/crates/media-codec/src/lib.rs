// SPDX-License-Identifier: Apache-2.0
//! Hardware-independent codec contracts. All timestamps are supplied by the caller.
mod contract;
pub mod fake;
mod picture;

pub use contract::*;
pub use picture::*;
