// SPDX-License-Identifier: Apache-2.0
//! GitHub (F2): `GitHubForge`, its inbox, repositories, reviews and threads, status and
//! review revisions, list caches, lifecycle and merge state, stacks, media, file contents,
//! people, reactions, suggestions and open work. F2 starts with the payload schemas and the
//! status mappings; the readers that drive `GhApi` follow in their own modules.

pub mod checks;
pub mod inbox;
pub mod lifecycle;
pub mod lifecycle_writes;
pub mod local_stacks;
pub mod merge_state;
pub mod new_pr;
pub mod repositories;
pub mod stacks;
pub mod status;

use crate::error::Error;

/// The part name the shell and the deferral payload use.
pub const PART: &str = "github";

/// `op`'s native entry point; F0's answer is the deferral.
pub fn probe(op: &str) -> Result<String, Error> {
    Err(Error::unimplemented(PART, op))
}
