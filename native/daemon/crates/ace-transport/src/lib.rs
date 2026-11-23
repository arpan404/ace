// SPDX-License-Identifier: Apache-2.0
//! The daemon's transport (ADR 0226): accepting connections, HTTP/1.1, the
//! WebSocket handshake and framing. T0 owns the skeleton: the error type only.

pub mod error;
