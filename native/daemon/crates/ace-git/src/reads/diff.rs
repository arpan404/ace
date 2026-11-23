// SPDX-License-Identifier: Apache-2.0
//! Commit and index diffs with patch bounds (G3b owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G3b replaces it with diff reads.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
