// SPDX-License-Identifier: Apache-2.0

//! Private snapshots of live provider databases (`snapshot-scratch.ts`, `sqlite-snapshot.ts`,
//! `provider-db.ts`): one at a time, inside a scratch cap and a free-space margin, and swept when
//! their owner is gone.

mod claim;
mod copy;
mod provider_db;
mod scratch;

pub use provider_db::{database_fingerprint, open_provider_db};
pub use scratch::{Policy, SnapshotScratch, WorkDir};

/// Another snapshot owns the single scratch slot; the next scan retries.
pub const BUSY: &str = "Another saved-history database snapshot is in progress; retrying later";
/// The database changed during its snapshot; retried later without a notice.
pub const CHANGED: &str =
    "Provider database changed during snapshot; retry when its writer settles";
