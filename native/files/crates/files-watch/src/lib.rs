// SPDX-License-Identifier: Apache-2.0

//! Watches a checkout root and reports coalesced change batches.
//!
//! The OS reports changes as events; this crate turns them into the news the Files panel
//! applies: one batch per quiet period, a rename as a deletion plus a creation, and a rescan
//! when the OS says it dropped events. Paths outside the root and inside `exclude` globs are
//! never reported.
//!
//! ```no_run
//! use files_safe::Root;
//! use files_watch::{Batch, WatchOptions, Watcher};
//! use std::time::Duration;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let root = Root::open(std::path::Path::new("."))?;
//! let options = WatchOptions {
//!     debounce: Duration::from_millis(75),
//!     exclude: vec!["**/node_modules/*/**".to_owned()],
//!     max_batch: 5_000,
//! };
//! let watcher = Watcher::start(root, options, Box::new(|batch: Batch| drop(batch)))?;
//! # drop(watcher);
//! # Ok(())
//! # }
//! ```

mod backend;
mod batch;
mod coalesce;
mod error;
mod exclude;
#[cfg(target_os = "linux")]
mod linux;
mod observed;
mod translate;
mod watch;

pub use batch::{Batch, Change, ChangeKind};
pub use error::Error;
pub use watch::{Mode, WatchOptions, Watcher};
