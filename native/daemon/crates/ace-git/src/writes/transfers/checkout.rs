// SPDX-License-Identifier: Apache-2.0
//! Landing branches, checkouts, fast-forwards and worktrees (G4c owns the
//! port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4c replaces it with landing checkouts.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
