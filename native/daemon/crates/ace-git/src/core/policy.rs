// SPDX-License-Identifier: Apache-2.0
//! The execution policy and its overrides (G2c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2c replaces it with the policy.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
