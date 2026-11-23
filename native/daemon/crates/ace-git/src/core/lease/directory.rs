// SPDX-License-Identifier: Apache-2.0
//! Held directories: Git runs in the descriptor, never by path (G2b owns the
//! port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2b replaces it with held directories.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
