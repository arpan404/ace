// SPDX-License-Identifier: Apache-2.0

//! Lists one folder of a checkout at a time, for the Files panel.
//!
//! A listing is one level deep and paged: the daemon asks for a folder, gets a page in VS Code's
//! order, and asks again with the cursor it was handed. Git's ignore rules are read from the root
//! down and reported per entry (the panel dims ignored entries) instead of being hidden, because
//! the user can and does open ignored folders.
//!
//! Paths in and out are relative to the root, `/` separated, and validated by `files-safe`.

mod cursor;
mod entry;
mod error;
mod git;
mod hide;
mod lister;
mod page;
mod rules;
mod snapshot;

pub use crate::entry::{Entry, Kind};
pub use crate::error::Error;
pub use crate::lister::Lister;
pub use crate::page::{ListOptions, Page};
