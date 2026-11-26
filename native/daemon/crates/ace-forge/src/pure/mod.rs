// SPDX-License-Identifier: Apache-2.0
//! The pure helpers (F6): Rust copies of the 13 modules the forge's own classes use, for the
//! forge's own use. The browser keeps the TypeScript copies (`apps/web`, `packages/ui-core`,
//! `packages/fake-daemon`). F0 declares the module only; every probe defers to TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "pure";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
