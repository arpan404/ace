// SPDX-License-Identifier: Apache-2.0
//! Transfer bundles (G4c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4c replaces it with bundles.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
