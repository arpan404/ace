// SPDX-License-Identifier: Apache-2.0
//! Mapping Git's exit and stderr to `GitError` codes (G2a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2a replaces it with the failure mapping.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
