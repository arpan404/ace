// SPDX-License-Identifier: Apache-2.0
//! The daemon's side of the relay (ADR 0155, docs/transport/porting-guide.md T6): what an NK first
//! message may cost before its client confirms, the early reads it may ask for, its host admission,
//! the relayed channel seen as a socket, and the Noise handshakes that carry all of it.
//!
//! The relay's wire and its hosted server are not here: this crate is the daemon's client of a
//! relay and its host half. Tests never contact the hosted relay; a local server stands in.

pub mod error;
pub mod http;
pub mod nk;
pub mod noise;
pub mod route;
pub mod socket;
pub mod wire;

pub use error::RelayError;
pub use http::{HOOKS_PATH, RelayHttpTarget, relay_http_enabled, relay_http_target};
pub use nk::admission::{
    Held, NK_LIMITS, NkAdmission, NkClock, NkLimits, NkSession, Rate, Remaining, Suppression,
    Suppressive,
};
pub use nk::early_reads::{
    BoundedRead, CursorUnreadable, EARLY_REPLAY_BYTES, EarlyEncoder, EarlyReads, EarlyStore,
    answer_early,
};
pub use nk::hello::{
    EARLY_SIDEBAR_WINDOWS, EARLY_SUBSCRIBES, EARLY_THREAD_SUBSCRIBES, EarlyScope, EarlySubscribe,
    HelloConfirm, HelloEarly, PairingLinkProof, RELAY_NK_HANDSHAKE, Tail, Window,
};
pub use nk::host::{
    AccountAdmission, NkAccepted, NkAccount, NkHost, account_device_actor, main_actor,
};
pub use noise::{
    Ephemeral, KeyPair, MAX_MESSAGE, NK_FIRST_MESSAGE_MINIMUM, NK_PROTOCOL, NoiseNk, NoiseXx,
    SessionKeys, XX_PROTOCOL, fingerprint, host_id,
};
pub use route::{RelayPairingRoute, RelayRoute, relay_pairing, relay_route};
pub use socket::{
    Frame, HostChannel, MAX_CLOSE_REASON, ReadyState, RelaySocket, SocketEvent, ended_by,
    slice_utf16,
};
pub use wire::{
    CONTROL_PROLOGUE, NK_REFUSAL_MS, NK_STREAM_PROLOGUE, PAIRED_MARKER, STREAM_PROLOGUE,
};

/// The 64 lowercase hex characters a one-use ticket is.
pub fn is_ticket(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
