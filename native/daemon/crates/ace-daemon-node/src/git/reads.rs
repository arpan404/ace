// SPDX-License-Identifier: Apache-2.0
//! The reads binding (G3 owns the port). G0 stub: panics caught and thrown
//! as `git_failed`; the stub error defers the shell to TypeScript.

use napi_derive::napi;

use super::caught;

/// Probes the reads path; G3 replaces it with status, info, diffs, history
/// and transfer reads.
#[napi(catch_unwind)]
pub fn git_reads_probe(op: String) -> napi::Result<String> {
    caught("git reads probe", || {
        ace_git::reads::status::probe(&op).map(|()| "ok".to_owned())
    })
}
