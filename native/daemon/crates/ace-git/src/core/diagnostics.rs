// SPDX-License-Identifier: Apache-2.0
//! Reading stderr for the failure tail without leaking it (G2a owns the
//! port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2a replaces it with diagnostics.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
