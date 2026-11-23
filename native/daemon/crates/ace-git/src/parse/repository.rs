// SPDX-License-Identifier: Apache-2.0
//! `parseWorktrees` and `parseRemotes` (G3a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe; G3a replaces it with the repository parser ports.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
