// SPDX-License-Identifier: Apache-2.0
//! The snapshot (G5 owns the port, S1–S13 step for step). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G5 replaces it with the snapshot.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("checkpoints", op))
}
