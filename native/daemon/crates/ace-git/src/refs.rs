// SPDX-License-Identifier: Apache-2.0
//! Ref, branch and worktree-list reads on `gix` (G1 owns the port). G0 stub.

// `gix` links here so the resolved workspace graph carries exactly the ADR's
// features; G1 calls it from this module, G7 from `reads::status_gix`, nowhere else.
use gix as _;

use crate::error::Error;

/// The G0 probe the binding calls; G1 replaces it with the ref reads.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("refs", op))
}
