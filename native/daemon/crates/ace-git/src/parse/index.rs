// SPDX-License-Identifier: Apache-2.0
//! `parseIndex` and `parseTree` (G3b owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe; G3b replaces it with the index parser ports.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
