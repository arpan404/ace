// SPDX-License-Identifier: Apache-2.0
//! The worktree-list half of the ref reads (G1 owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G1 replaces it with the worktree listing.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("refs", op))
}
