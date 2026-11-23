// SPDX-License-Identifier: Apache-2.0
//! Publication scans and remotes (G3d owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G3d replaces it with publication reads.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
