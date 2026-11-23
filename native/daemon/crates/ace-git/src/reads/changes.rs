// SPDX-License-Identifier: Apache-2.0
//! `changedFiles`, summaries and source-control state (G3a owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G3a replaces it with change reads.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
