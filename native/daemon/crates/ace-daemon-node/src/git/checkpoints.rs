// SPDX-License-Identifier: Apache-2.0
//! The checkpoints binding (G5 owns the port; G6 adds `snapshot-hash`).
//! G0 stub: panics caught and thrown as `git_failed`; the stub error defers
//! the shell to TypeScript.

use napi_derive::napi;

use super::caught;

/// Probes the checkpoints path; G5 replaces it with snapshots, live diffs
/// and restore, and G6 with the hashed snapshot step.
#[napi(catch_unwind)]
pub fn git_checkpoints_probe(op: String) -> napi::Result<String> {
    caught("git checkpoints probe", || {
        ace_git::checkpoints::probe(&op).map(|()| "ok".to_owned())
    })
}
