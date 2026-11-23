// SPDX-License-Identifier: Apache-2.0
//! Per-call deadlines (`git_timeout` with args, cancellation before and after
//! dispatch). G2a owns the port. G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2a replaces it with the deadline rules.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
