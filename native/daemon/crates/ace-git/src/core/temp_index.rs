// SPDX-License-Identifier: Apache-2.0
//! Temporary-index settings (G2c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2c replaces it with index settings.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
