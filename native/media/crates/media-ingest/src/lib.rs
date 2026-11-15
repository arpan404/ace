// SPDX-License-Identifier: Apache-2.0
//! A native producer's side of ace-media's ingest (docs/media/plan.md, "Ingest framing", E1
//! and E2): MediaFrame v1 framing of encoded units, one connection's writer, and the route that
//! moves a producer's video between the daemon's path and ace-media with an exact boundary.
//!
//! Sans-IO. Nothing here has a thread, a socket or a clock: the shell feeds events (a unit,
//! a write finished or failed, the socket closed, a tick with its `now`) and carries out the
//! actions returned (write these bytes, end or destroy a connection, report a cut). The rules
//! are those of the daemon's own writer, `packages/media/src/ingest-writer.ts`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
pub mod epochs;
pub mod frame;
pub mod route;
pub mod writer;

pub use frame::VideoUnit;
pub use route::{Address, Route, RouteAction, Switch};
pub use writer::{Action, Bytes, Cut, Writer, WriterState};
