// SPDX-License-Identifier: Apache-2.0
//! Worktree creation, removal, cleanup and backup (G4b owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4b replaces it with worktree writes.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
