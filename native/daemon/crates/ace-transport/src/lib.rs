// SPDX-License-Identifier: Apache-2.0
//! The daemon's transport (ADR 0226): accepting connections, HTTP/1.1, the
//! WebSocket handshake and framing. T0 owns the skeleton; T1a.2 owns the
//! loopback listener, the connection driver, the HTTP proxy hop and the guard
//! on the hop's headers.

pub mod driver;
pub mod error;
pub mod head;
pub mod hop;
pub mod listener;
pub mod peer;
pub mod prefixed;
pub mod proxy;
pub mod upgrade;

pub use driver::{RefuseUpgrades, UpgradeHandler, UpgradeIo, UpgradeReply};
pub use error::TransportError;
pub use head::RequestHead;
pub use hop::HopSecret;
pub use listener::LoopbackListener;
pub use peer::Peer;
pub use prefixed::{Prefixed, TimedIo};
pub use proxy::ProxyTarget;
pub use upgrade::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeRequest,
    WebSocketUpgrades,
};
