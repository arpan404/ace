// SPDX-License-Identifier: Apache-2.0
//! Display-only status on `gix` (G7 owns the port, after G1 and the owner's
//! call). Never for a read that precedes or guards a write. G0 stub.

// `gix` links here so the resolved workspace graph carries exactly the ADR's
// features; G7 calls it from this module, G1 from `refs`, nowhere else.
use gix as _;

use crate::error::Error;

/// The G0 probe the binding calls; G7 replaces it with `gix` status.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("status-gix", op))
}
