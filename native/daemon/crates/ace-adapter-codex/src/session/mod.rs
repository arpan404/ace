// SPDX-License-Identifier: Apache-2.0
//! The Codex session's shared app-server (E3-codex.2): one process per
//! account, shared by sessions, and the routing, pool and lease pieces around
//! it. Ported from `host.ts`, `host-routing.ts`, `host-pool.ts`,
//! `thread-lease.ts` and `app-server.ts`.

pub mod app_server;
pub mod dropped;
pub mod frames;
pub mod host;
pub mod lease;
pub mod pool;
pub mod routing;
pub mod terminals;
pub mod tools;

#[cfg(test)]
pub(crate) mod harness;
