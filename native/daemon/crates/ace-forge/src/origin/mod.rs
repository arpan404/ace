// SPDX-License-Identifier: Apache-2.0
//! Cursor Origin (F5): `OriginReader` (read-only), `OriginListSnapshots` and `origin`
//! readiness, through `origin`. F0 declares the module only; every probe defers to TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "origin";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
