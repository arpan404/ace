// SPDX-License-Identifier: Apache-2.0
//! Phase 3: the sidebar and thread lists (docs/store/porting-guide.md).
//!
//! The TypeScript loaders keep issuing their SQL on the store's connection,
//! inside the store's read savepoint, and hand the rows they read to
//! [`decode::decode_thread_rows`] as one JSON string. Decoding is the measured
//! cost of these reads (71-74% outside SQLite on a sidebar page), so it moves
//! here; the SQL, the caches, the snapshot and the freezing stay in TypeScript.

pub mod decode;

pub use decode::{Error, Result, decode_thread_rows};
