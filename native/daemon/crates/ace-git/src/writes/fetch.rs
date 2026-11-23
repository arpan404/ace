// SPDX-License-Identifier: Apache-2.0
//! Fetch, branch fetch and PR-head fetch (G4d owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4d replaces it with fetches.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
