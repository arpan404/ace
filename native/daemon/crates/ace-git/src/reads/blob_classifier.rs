// SPDX-License-Identifier: Apache-2.0
//! The bounded-memory binary classifier over `cat-file --batch` (G3b owns the
//! port). G0 stub.

use crate::error::Error;

/// The G0 probe the binding calls; G3b replaces it with the classifier.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("reads", op))
}
