// SPDX-License-Identifier: Apache-2.0
//! The Windows job strategy chosen by the platform port (G2a owns the port).
//! G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2a replaces it with the job strategy.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
