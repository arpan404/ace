// SPDX-License-Identifier: Apache-2.0
//! Checkpoints, live diffs, workspace revisions and restore, ported step for
//! step (G5 owns the port): S1–S13 exactly as today, then only S9–S10 change
//! in G6 (`snapshot-hash`).
//!
//! - `snapshot`: S1–S13 on a temporary index, with nested repositories flattened.
//! - `nested`: discovery, linked worktrees, flattening and the ignored paths a
//!   restore must not overwrite.
//! - `metadata`: the ref namespace, the id's sequence and the commit message.
//! - `numbers`: the durable counter, its migration and the bounded cache.
//! - `bytes`: the files' own bytes beside the tree (Windows).
//! - `create`: allocate, publish, read, list and delete checkpoints.

pub mod bytes;
pub mod create;
pub mod hash;
pub mod metadata;
pub mod nested;
pub mod numbers;
pub mod restore;
pub mod snapshot;
pub mod transfer;
pub mod workspace;

/// The G0 probe the binding still calls for an operation this item has not wired to the
/// shell yet; it defers that operation to TypeScript, as every stub did.
pub fn probe(op: &str) -> Result<(), crate::error::Error> {
    Err(crate::error::Error::unimplemented("checkpoints", op))
}
