// SPDX-License-Identifier: Apache-2.0
//! Blocking connection layer between the Rust `ace` CLI and an ace daemon (ADR 0221).

pub mod error;
mod fragments;
pub mod home;
pub mod http;
pub mod origin;
pub mod profile;
pub mod protocol;
pub mod stream;
pub mod tls;
pub mod types;
mod ureq_tls;
pub mod ws;
mod ws_io;
pub mod x509;

pub use error::{
    CliErrorCode, CliOutcome, DAEMON_DOWN_HINT, DAEMON_DOWN_MESSAGE, FailureMapping, WireError,
};
pub use home::{
    Home, Local, PROBE_TIMEOUT, Probe, ProbeAnswer, TcpProbe, host_connection,
    parse_host_connection, reach_local,
};
pub use http::{
    DEFAULT_HTTP_TIMEOUT, HttpMethod, HttpResponse, MAX_HTTP_RESPONSE_BYTES, exchange_ticket,
    exchange_ticket_with_tls, http_request_local, http_request_local_json, http_request_remote,
    http_request_remote_with_tls,
};
pub use origin::{LocalOrigin, RemoteOrigin, is_tailnet_name};
pub use profile::{DirectRemote, ProfileName, ProfileRelay, RemoteProfile, SocketTicket};
pub use protocol::{
    Credential, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_REQUEST_TIMEOUT, MAX_FRAME_BYTES,
    MAX_SEND_BYTES, PROTOCOL_VERSION, Reply, Welcome, expected_reply_types,
};
pub use tls::{Clock, SystemClock, TlsPinConfig};
pub use types::{DeviceId, Fingerprint, HostId, LocalIdentity, RequestId, Ticket, Token, is_hex64};
pub use ws::{ConnectConfig, Connection};
pub use x509::{
    CertificateInfo, parse_leaf_certificate, sha256_fingerprint, spki_sha256_fingerprint,
};
