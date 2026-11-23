// SPDX-License-Identifier: Apache-2.0
//! Numstat records (G3a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe; G3a replaces it with the numstat port.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
