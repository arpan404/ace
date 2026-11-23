// SPDX-License-Identifier: Apache-2.0
//! The lease journal: the on-disk records one backend reads from the other
//! (G2b owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2b replaces it with the journal.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
