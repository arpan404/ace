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
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let root = Root::open(std::path::Path::new("."))?;
//! let options = WatchOptions {
//!     exclude: vec!["**/node_modules/*/**".to_owned()],
//!     ..WatchOptions::default()
//! };
//! let watcher = Watcher::start(root, options, Box::new(|batch: Batch| drop(batch)))?;
//! # drop(watcher);
//! # Ok(())
//! # }
//! ```

mod adopt;
mod backend;
mod batch;
mod coalesce;
mod error;
mod exclude;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod net;
mod observed;
mod translate;
mod wake;
mod watch;
#[cfg(windows)]
mod windows;

pub use batch::{Batch, Change, ChangeKind};
pub use error::Error;
pub use watch::{Mode, WatchOptions, Watcher};
