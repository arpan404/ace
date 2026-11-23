// SPDX-License-Identifier: Apache-2.0
//! Leases, locks and the Git process scan (G2b owns the port). G0 stub: every
//! module declared so parallel builders never edit the same file.

pub mod admission;
pub mod directory;
pub mod facts;
pub mod journal;
pub mod locks;
pub mod mutation;
pub mod owner;
pub mod processes;
pub mod roots;
pub mod state;
