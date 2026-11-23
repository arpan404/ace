// SPDX-License-Identifier: Apache-2.0
//! Clone, init and project setup (G4c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4c replaces it with project writes.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
