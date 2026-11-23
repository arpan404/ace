// SPDX-License-Identifier: Apache-2.0
//! One operation per root at a time across every instance (`serial` keyed by
//! canonical root). G2b owns the port. G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G2b replaces it with `serial`.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("core", op))
}
