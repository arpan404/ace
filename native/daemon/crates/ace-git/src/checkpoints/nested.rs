// SPDX-License-Identifier: Apache-2.0
//! Nested-checkout discovery and the excluded set (G5 owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G5 replaces it with nested discovery.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("checkpoints", op))
}
