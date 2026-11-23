// SPDX-License-Identifier: Apache-2.0
//! File-log parsing (G3c owns the port). G0 stub.

use crate::error::Error;

/// The G0 probe; G3c replaces it with the history parser port.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
