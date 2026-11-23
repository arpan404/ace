// SPDX-License-Identifier: Apache-2.0
//! Temporary-index bytes (G5 owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G5 replaces it with index bytes.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("checkpoints", op))
}
