// SPDX-License-Identifier: Apache-2.0
//! The ref binding (G1 owns the port). G0 stub: panics caught and thrown as
//! `git_failed`; the stub error defers the shell to TypeScript.

use napi_derive::napi;

use super::caught;

/// Probes the ref path; G1 replaces it with the ref, branch and worktree-list reads.
#[napi(catch_unwind)]
pub fn git_refs_probe(op: String) -> napi::Result<String> {
    caught("git refs probe", || {
        ace_git::refs::probe(&op).map(|()| "ok".to_owned())
    })
}
