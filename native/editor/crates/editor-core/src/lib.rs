// SPDX-License-Identifier: Apache-2.0

//! The ace editor's text core: a rope buffer, multi-cursor transactions, undo, find and line
//! commands. Rendering and input stay in the clients; this crate decides what the text becomes.
//!
//! Positions are line plus UTF-16 column, the unit the DOM reports. A [`Document`] owns one
//! document's text, selections, undo history and version. Every command builds a [`Transaction`]
//! from the current selections and applies it to all of them at once.

mod applied;
mod buffer;
mod commands;
mod document;
mod error;
mod find;
mod history;
mod position;
mod selection;
mod transaction;

pub use buffer::LineEnding;
pub use document::Document;
pub use error::Error;
pub use find::FindQuery;
pub use position::{Position, Range};
pub use selection::Selection;
pub use transaction::{Applied, Change, LineEdit, Replacement, Transaction};
