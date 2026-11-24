// SPDX-License-Identifier: Apache-2.0
//! The remote listeners (T1b.1a): TLS termination in front of the same driver,
//! proxy hop and upgrade handlers the loopback listener uses. One type serves
//! both remote listeners — the static `node:https` one and the run-time SNI one
//! `remoteDirect` builds — and they differ only in their
//! `ConnectionLimits` and in the trusted certificate the resolver holds.

pub mod listener;

pub use listener::RemoteListener;

#[cfg(test)]
mod tests;
