// SPDX-License-Identifier: Apache-2.0
//! Checkpoints, live diffs, workspace revisions and restore, ported step for
//! step (G5 owns the port): S1–S13 exactly as today, then only S9–S10 change
//! in G6 (`snapshot-hash`). G0 stub: every module declared so parallel
//! builders never edit the same file.

pub mod bytes;
pub mod hash;
pub mod metadata;
pub mod nested;
pub mod numbers;
pub mod restore;
pub mod snapshot;
