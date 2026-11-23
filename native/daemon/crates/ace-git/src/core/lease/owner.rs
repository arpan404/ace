// SPDX-License-Identifier: Apache-2.0
//! Lease ownership and quarantine healing (G2b owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2b replaces it with ownership.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
