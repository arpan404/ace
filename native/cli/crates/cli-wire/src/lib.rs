// SPDX-License-Identifier: Apache-2.0
//! Blocking connection layer between the Rust `ace` CLI and an ace daemon (ADR 0221).

pub mod error;
pub mod home;
pub mod http;
pub mod http_parse;
pub mod origin;
pub mod protocol;
pub mod stream;
pub mod types;
pub mod ws;

pub use error::{
    CliErrorCode, CliOutcome, DAEMON_DOWN_HINT, DAEMON_DOWN_MESSAGE, FailureMapping, WireError,
};
pub use home::{
    Home, Local, PROBE_TIMEOUT, Probe, ProbeAnswer, TcpProbe, host_connection,
    parse_host_connection, reach_local,
};
pub use http::{
    DEFAULT_HTTP_TIMEOUT, HttpMethod, HttpResponse, MAX_HTTP_RESPONSE_BYTES, http_request_local,
    http_request_local_json,
};
pub use origin::{LocalOrigin, RemoteOrigin, is_tailnet_name};
pub use protocol::{
    Credential, DEFAULT_COLD_START_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_REQUEST_TIMEOUT,
    MAX_FRAME_BYTES, MAX_SEND_BYTES, PROTOCOL_VERSION, Reply, Welcome,
};
pub use types::{DeviceId, Fingerprint, HostId, RequestId, Ticket, Token, is_hex64};
pub use ws::{ConnectConfig, Connection};
