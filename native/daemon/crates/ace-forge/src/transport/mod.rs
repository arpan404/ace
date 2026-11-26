// SPDX-License-Identifier: Apache-2.0
//! The transport (F1 of docs/forge/porting-guide.md): the runner (`command.ts`), `GhApi`
//! (`http.ts`), write classification and `MutationDispatch`, read-only admission, pinned
//! identities, readiness and error kinds. Every host request goes through it; one person's CLI
//! process per request, through `ace-supervisor`. F0 declares the module and the runner's port
//! bridge only; every probe defers to TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "transport";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
