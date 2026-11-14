// SPDX-License-Identifier: Apache-2.0
//! ace-media, the media process (ADR 0147). Pure decisions live in [`engine`], [`auth`] and
//! [`probe`]'s merge rules; [`shell`] is the thin I/O around them.
pub mod auth;
pub mod engine;
pub mod framing;
pub mod os;
pub mod probe;
pub mod secret;
#[cfg(unix)]
pub mod shell;
