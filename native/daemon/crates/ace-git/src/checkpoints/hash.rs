// SPDX-License-Identifier: Apache-2.0
//! `snapshot-hash` (G6 owns the port, blocked until G5 ships): blob ids of
//! the conversion-free set, with Git still seeding, listing, deciding and
//! assembling. Needs no `gix`: blob ids come from `gix-hash` and
//! `gix-object`, root-relative reads from `cap-std`. G0 stub.

use crate::error::Error;

/// The G0 probe; G6 replaces it with the hashed snapshot step.
pub fn probe(op: &str) -> Result<(), Error> {
    Err(Error::unimplemented("snapshot-hash", op))
}
