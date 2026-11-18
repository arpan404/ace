// SPDX-License-Identifier: Apache-2.0

//! The Wasm surface of ace's editor core.
//!
//! [`EditorDocument`] wraps [`editor_core::Document`] for JavaScript, and [`line_marks`] exposes
//! `editor_diff::line_marks` for the gutter. Everything hot crosses the boundary as flat arrays:
//!
//! - positions are `(line, column)` pairs in a `Uint32Array`;
//! - selections are `(anchor line, anchor column, head line, head column)` quads;
//! - a transaction is a range quad array plus one text per range;
//! - an applied edit is `{ version, spans }` with `(first line, removed, inserted)` triples;
//! - gutter marks are `(line, kind)` pairs with `0 = added`, `1 = modified`, `2 = removed`.
//!
//! Only the lines a view draws are fetched as strings, one [`EditorDocument::lines`] call per
//! visible range, and the whole text only when the caller asks for it.
//!
//! A rejected call throws a JavaScript `Error` whose `code` property is the shared error code
//! (`INVALID_ARGUMENT` for every rejection the core can produce).

mod applied;
mod convert;
mod document;
mod error;
mod marks;

pub use applied::Applied;
pub use document::EditorDocument;
pub use marks::line_marks;
