// SPDX-License-Identifier: Apache-2.0
//! Integrations (`integrate`, `excludeAcePrivate`) (G4a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G4a replaces it with integrations.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("writes", op))
}
