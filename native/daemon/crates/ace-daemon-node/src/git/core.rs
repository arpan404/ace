// SPDX-License-Identifier: Apache-2.0
//! The core binding (G2 owns the port): the process layer (G2a), ordering
//! and leases (G2b), policy and configuration (G2c). G0 stub: panics caught
//! and thrown as `git_failed`; the stub error defers the shell to TypeScript.

use napi_derive::napi;

use super::caught;

/// Probes the core path; G2 replaces it with the core.
#[napi(catch_unwind)]
pub fn git_core_probe(op: String) -> napi::Result<String> {
    caught("git core probe", || {
        ace_git::core::cli::probe(&op).map(|()| "ok".to_owned())
    })
}
