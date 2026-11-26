// SPDX-License-Identifier: Apache-2.0

//! The daemon's side of `ace-screen-helper --computer` (ADR 0225, S1): the helper pool behind
//! `@ace/screen`'s `ComputerClient`, its per-app connections, the reply wire and the request
//! timing spans (`packages/screen/src/computer/`).
//!
//! The helpers stay native processes and their wire stays byte for byte: one JSON line per
//! request in, one per reply out. Nothing links a helper into the daemon.

pub mod catalog;
pub mod computer;
pub mod error;

pub use computer::client::{
    ComputerClient, ComputerClientOptions, RequestOptions, default_deadline_ms,
};
pub use computer::connection::Dispatch;
pub use computer::connection::{Connection, ConnectionOptions};
pub use error::ComputerError;
