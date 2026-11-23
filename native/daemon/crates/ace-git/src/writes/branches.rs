// SPDX-License-Identifier: Apache-2.0
//! Branch writes, switch and cleanup (G4a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4a replaces it with branch writes.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
