// SPDX-License-Identifier: Apache-2.0
//! The transport (F1 of docs/forge/porting-guide.md): the runner every host request goes
//! through, the fixed error categories, write classification and dispatch certainty,
//! read-only admission and write scopes, `GhApi`'s caches, polling, read budgets, SSH host
//! aliases and the repository key.
//!
//! Rules this module keeps (ADR 0224 §8, §8a): every request is one run of the person's own
//! CLI through `ace-supervisor`; no CLI configuration, keychain or token is read, stored or
//! logged; every reply, stderr tail and diagnostic is redacted before it is cached or
//! returned; nothing secret leaves this boundary.

pub mod admission;
pub mod command;
pub mod error;
pub mod http;
pub mod identity;
pub mod key;
pub mod limits;
pub mod mutation;
pub mod poll;
pub mod readiness;
pub mod redact;
pub mod ssh;
pub mod tail;

/// The part name the probe and the deferral payload use.
pub const PART: &str = "transport";

/// `op`'s native entry point. F1 declares the module and its behaviour; the GitHub reader
/// that drives it arrives with F2, so no operation is exposed as a probe yet.
pub fn probe(op: &str) -> Result<String, crate::error::Error> {
    Err(crate::error::Error::unimplemented(PART, op))
}
