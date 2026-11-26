// SPDX-License-Identifier: Apache-2.0
//! The Cursor session (E3): the host's wire core (`host.ts`), its acknowledgement book, the SDK
//! boundary contract (`contracts.ts`) and the bound walk every host value passes before it can
//! become a frame. Sans-IO throughout: the facade owns the process, its pipes, its stop plan and
//! every piece of host prose that needs redaction.

pub mod ack;
pub mod bounded;
pub mod commands;
pub mod core;
pub mod envelope;
pub mod error;
pub mod failure;
pub mod frames;
pub mod host;
pub mod io;

pub use ack::{Ack, AckBook};
pub use bounded::{BoundedError, DEFAULT_MAX_BYTES, bounded_check, bounded_json};
pub use envelope::{CursorLimits, Envelope, limits, normalize, parse, unbatch};
pub use error::{ACE_CURSOR_RPC, HostErrorWire, SessionError};
pub use failure::{ExitState, MappedFailure, RequestFailure, request_failure};
pub use host::{
    CursorHostConfig, CursorHostCore, HostEffect, MALFORMED, PEER_CLOSED, PORT_CONNECTION,
    PORT_ERROR_FRAME, PORT_STDERR, PORT_STOP, PORT_STRAY, PROCESS_EXITED,
};
