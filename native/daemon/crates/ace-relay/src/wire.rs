// SPDX-License-Identifier: Apache-2.0
//! The relay's wire constants (`apps/relay/src/wire.ts`): the prologues each handshake binds to,
//! the byte a relay sends when a host stream is paired, and the deadline an NK refusal closes at.

/// The prologue of the relay's host control session (`/host`).
pub const CONTROL_PROLOGUE: &[u8] = b"ace relay registration v1";
/// The prologue of a stream opened with Noise XX.
pub const STREAM_PROLOGUE: &[u8] = b"ace daemon relay stream v1";
/// The prologue of a stream opened with Noise NK (ADR 0155, step 2).
pub const NK_STREAM_PROLOGUE: &[u8] = b"ace daemon relay stream v2 nk";

/// The one-byte marker a relay sends a client once its host stream is paired.
pub const PAIRED_MARKER: u8 = 1;

/// Every refusal of an NK first message closes the stream this long after the message arrived,
/// whatever the reason and however long the daemon's check takes (ADR 0155, step 2).
pub const NK_REFUSAL_MS: i64 = 150;
