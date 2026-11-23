// SPDX-License-Identifier: Apache-2.0
//! Spawning through the supervisor with the core's environment, `--no-pager`
//! and capture rules (G2a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2a replaces it with supervised spawning.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
