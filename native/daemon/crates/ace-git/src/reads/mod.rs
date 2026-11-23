// SPDX-License-Identifier: Apache-2.0
//! Every read on the core (G3 owns the port): status, info, summaries,
//! diffs, history, transfers and the display-only `status-gix`. G0 stub.

pub mod blob_classifier;
pub mod changes;
pub mod conflicts;
pub mod diff;
pub mod history;
pub mod info;
pub mod publication;
pub mod remote;
pub mod revision_lines;
pub mod status;
pub mod status_gix;
pub mod transfer_reads;
pub mod worktree_facts;
