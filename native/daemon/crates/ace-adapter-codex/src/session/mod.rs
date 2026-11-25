// SPDX-License-Identifier: Apache-2.0
//! The Codex session, in three layers: the shared app-server (E3-codex.2: one
//! process per account, shared by sessions, with the routing, pool and lease
//! pieces around it), the session's own per-frame state and capture
//! (E3-codex.3), and the commands and admission built on them (E3-codex.4).

pub mod app_server;
pub mod discovery;
pub mod dropped;
pub mod frames;
pub mod host;
pub mod input;
pub mod lease;
pub mod lifetime;
pub mod permissions;
pub mod pool;
pub mod routing;
pub mod selection;
pub mod state;
pub mod terminals;
pub mod tools;

#[cfg(test)]
pub(crate) mod harness;
