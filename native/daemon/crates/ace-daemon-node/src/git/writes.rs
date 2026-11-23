// SPDX-License-Identifier: Apache-2.0
//! The writes binding (G4 owns the port). G0 stub: panics caught and thrown
//! as `git_failed`; the stub error defers the shell to TypeScript.

use napi_derive::napi;

use super::caught;

/// Probes the writes path; G4 replaces it with commits, branches, worktrees,
/// transfers, merges and fetches.
#[napi(catch_unwind)]
pub fn git_writes_probe(op: String) -> napi::Result<String> {
    caught("git writes probe", || {
        ace_git::writes::commit::probe(&op).map(|()| "ok".to_owned())
    })
}
