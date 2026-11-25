// SPDX-License-Identifier: Apache-2.0
//! The git core (G2 owns the port): the process layer (G2a), ordering and
//! leases (G2b), policy and configuration (G2c). G0 stub: every module
//! declared, each deferring to TypeScript through the shells.

pub mod cli;
pub mod config;
pub mod credentials;
pub mod deadline;
pub mod decode;
pub mod diagnostics;
pub mod error;
pub mod failure;
pub mod job;
pub mod lease;
pub mod paths;
pub mod policy;
pub mod read_gate;
pub mod reviewer;
pub mod serial;
pub mod spawn;
pub mod temp_index;
pub mod transport;
