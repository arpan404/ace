// SPDX-License-Identifier: Apache-2.0
//! Blocking connection layer between the Rust `ace` CLI and an ace daemon (ADR 0221).

pub mod error;
pub mod home;
pub mod types;

pub use error::{
    CliErrorCode, CliOutcome, DAEMON_DOWN_HINT, DAEMON_DOWN_MESSAGE, FailureMapping, WireError,
};
pub use home::{
    Home, Local, PROBE_TIMEOUT, Probe, ProbeAnswer, TcpProbe, host_connection,
    parse_host_connection, reach_local,
};
pub use types::{
    DeviceId, Fingerprint, HostId, LocalOrigin, RemoteOrigin, RequestId, Ticket, Token, is_hex64,
    is_tailnet_name,
};
