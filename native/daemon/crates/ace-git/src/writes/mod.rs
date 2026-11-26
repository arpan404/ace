// SPDX-License-Identifier: Apache-2.0
//! Writes that make no checkpoint (G4 owns the port): commits, staging,
//! branches, worktrees, transfers, merges and fetches, each running the
//! person's hooks and signing in their roots exactly where TypeScript does.
//! G0 stub.

pub mod bind;
pub mod branches;
pub mod commit;
pub mod context;
pub mod fetch;
pub mod integration;
pub mod merge;
pub mod overlap;
pub mod private;
pub mod projects;
pub mod publication;
pub mod push;
pub mod stack;
pub mod stage;
pub mod transfers;
pub mod worktrees;
