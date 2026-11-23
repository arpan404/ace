// SPDX-License-Identifier: Apache-2.0
//! Publications and their credentials (G4c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4c replaces it with publications.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
