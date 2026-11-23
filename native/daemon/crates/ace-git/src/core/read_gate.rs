// SPDX-License-Identifier: Apache-2.0
//! `ReadGate(2)` for history reads that skip the root lock (G2b owns the
//! port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2b replaces it with the read gate.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
