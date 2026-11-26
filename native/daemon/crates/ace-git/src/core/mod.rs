// SPDX-License-Identifier: Apache-2.0
//! The git core (G2 owns the port): the process layer (G2a), ordering and
//! leases (G2b), policy and configuration (G2c). G0 stub: every module
//! declared, each deferring to TypeScript through the shells.

pub mod cancel;
pub mod capture;
pub mod cli;
pub mod config;
pub mod credentials;
pub mod deadline;
pub mod decode;
pub mod diagnostics;
pub mod error;
pub mod events;
pub mod execute;
pub mod execute_types;
pub mod failure;
pub mod hookless;
pub mod job;
pub mod lease;
pub mod objects;
pub mod paths;
pub mod policy;
pub mod ports;
pub mod read_gate;
pub mod reviewer;
pub mod serial;
pub mod spawn;
pub mod teardown;
pub mod temp_index;
pub mod transport;
pub mod wake;
