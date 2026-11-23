// SPDX-License-Identifier: Apache-2.0
//! Immutable revision lines (G3c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G3c replaces it with revision lines.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
