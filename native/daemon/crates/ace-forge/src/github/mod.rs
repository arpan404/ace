// SPDX-License-Identifier: Apache-2.0
//! GitHub (F2): `GitHubForge`, its inbox, repositories, reviews and threads, status and
//! review revisions, list caches, lifecycle and merge state, stacks, media, file contents,
//! people, reactions, suggestions and open work. F0 declares the module only; every probe
//! defers to TypeScript.

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "github";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
