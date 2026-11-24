// SPDX-License-Identifier: Apache-2.0
//! The daemon's transport (ADR 0226): accepting connections, HTTP/1.1, the
//! WebSocket handshake and framing, and TLS termination for the remote
//! listeners. T0 owns the skeleton; T1a.2 owns the loopback listener, the
//! connection driver, the HTTP proxy hop and the guard on the hop's headers;
//! T1b.1a adds the stream seam, the connection limits, the shared accept loop
//! and TLS with the remote listener.

mod accept;
pub mod conn_io;
pub mod driver;
pub mod error;
pub mod frame;
pub mod head;
pub mod hop;
pub mod limits;
pub mod listener;
pub mod peer;
pub mod prefixed;
pub mod proxy;
pub mod remote;
pub mod socket;
pub mod tls;
pub mod upgrade;

pub use conn_io::ConnIo;
pub use driver::{Grace, RefuseUpgrades, UpgradeHandler, UpgradeIo, UpgradeReply};
pub use error::TransportError;
pub use head::RequestHead;
pub use hop::HopSecret;
pub use limits::{ConnectionLimits, SniLimits};
pub use listener::LoopbackListener;
pub use peer::Peer;
pub use prefixed::{Prefixed, TimedIo};
pub use proxy::ProxyTarget;
pub use remote::RemoteListener;
pub use socket::{SendResult, SocketEvent, SocketEvents, SocketHandle, underflow_count};
pub use tls::{SniResolver, TlsIdentity, process_provider};
pub use upgrade::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeRequest,
    WebSocketUpgrades,
};
