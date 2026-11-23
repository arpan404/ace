// SPDX-License-Identifier: Apache-2.0
//! The strict output schemas (`decode.ts`: path, ref, hash and mode schemas)
//! over `ace_json` values (G2c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2c replaces it with the schemas.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
