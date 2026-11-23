// SPDX-License-Identifier: Apache-2.0
//! The transfer service orchestration (G4c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4c replaces it with the service.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
