// SPDX-License-Identifier: Apache-2.0
//! File log and commit diffs (G3c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G3c replaces it with history reads.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
