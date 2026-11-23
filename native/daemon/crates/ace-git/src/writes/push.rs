// SPDX-License-Identifier: Apache-2.0
//! Push, leased push and push publications (G4a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4a replaces it with pushes.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
