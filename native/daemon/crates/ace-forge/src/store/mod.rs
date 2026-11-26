// SPDX-License-Identifier: Apache-2.0
//! The forge's tables (F7): `ForgeStore`, `ForgeIntents` and reply receipts on `ace-store`'s
//! connection, with the same tables, columns and rows. F0 declares the module only; every
//! probe defers to TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "store";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
