// SPDX-License-Identifier: Apache-2.0
//! The forge's tables (F7): `ForgeStore`, `ForgeIntents` and reply receipts on `ace-store`'s
//! connection, with the same tables, columns and rows.

pub mod forge_store;
pub mod intents;
pub mod reply_receipts;

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "store";

/// `op`'s native entry point.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
