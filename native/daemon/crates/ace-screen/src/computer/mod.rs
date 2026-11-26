// SPDX-License-Identifier: Apache-2.0

//! The computer client's parts, split by responsibility (`packages/screen/src/computer/`):
//! `client` is the pool, `connection` one helper and its queue, `wire` the reply envelope,
//! `reply_lines` splits stdout into bounded lines, and `timing` is the diagnostics span.

pub mod client;
pub mod connection;
pub mod reply_lines;
pub mod spawn;
pub mod timing;
pub mod wire;
