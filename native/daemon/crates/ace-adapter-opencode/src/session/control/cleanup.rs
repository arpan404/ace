// SPDX-License-Identifier: Apache-2.0
//! Closing a session ace owns (`cleanup.ts`): the shells it started go first, then
//! every owned session is interrupted, deepest first.
//!
//! Only verified owners receive a command, and a session with no known directory
//! is skipped: the request needs a location. The caller runs the plan with a
//! shutdown budget and ignores each request's failure — the last owned server
//! lease still stops the process.

use super::Request;
use crate::session::api::{self, ApiError};
use crate::session::ownership::{OwnershipError, SessionOwnership};
use ace_json::json;

/// Why no cleanup plan could be built.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CleanupError {
    #[error("OpenCode cleanup ancestry: {0}")]
    Ownership(#[from] OwnershipError),
    /// The table needs a field the ownership lacks. Ownership never holds an
    /// empty id, so this is a programming error, not a provider's.
    #[error("OpenCode cleanup route: {0}")]
    Route(#[from] ApiError),
}

/// The requests that close the tree, in order: every owned shell's removal, then
/// the root's descendants and the root itself, each interrupted in its own
/// directory.
pub fn plan(ownership: &SessionOwnership) -> Result<Vec<Request>, CleanupError> {
    // The TypeScript returns before the shells when there is no root (`cleanup.ts:8`).
    // Ownership is only written by `establish`/`admit`, and a shell is recorded against a
    // session that was already owned, so this cannot change today's plan; it keeps the
    // TypeScript's order for when a shell can exist before a root does.
    if ownership.root().is_empty() {
        return Ok(Vec::new());
    }
    let mut requests = Vec::new();
    for (id, owner) in ownership.shells() {
        let Some(session) = ownership.sessions().get(owner) else {
            continue;
        };
        requests.push(Request::new(
            session.directory.clone(),
            api::call(
                "shell.remove",
                &json!({ "id": id, "location": { "directory": session.directory } }),
            )?,
        ));
    }
    let mut sessions = ownership.descendants(ownership.root())?;
    sessions.push(ownership.root().to_owned());
    for id in sessions {
        let Some(session) = ownership.sessions().get(&id) else {
            continue;
        };
        requests.push(Request::new(
            session.directory.clone(),
            api::call("session.interrupt", &json!({ "sessionID": id }))?,
        ));
    }
    Ok(requests)
}

#[cfg(test)]
mod tests;
