// SPDX-License-Identifier: Apache-2.0
//! Lease admission: writers wait for a clearing lease, else `git_quarantined`
//! (G2b owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2b replaces it with admission.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
