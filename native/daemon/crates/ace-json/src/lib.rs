// SPDX-License-Identifier: Apache-2.0
//! JSON exactly as JavaScript sees it, for every Rust crate in the daemon. Facts and native
//! keys must be byte-identical whichever backend wrote them, so this follows `JSON.parse` and
//! `JSON.stringify` rather than serde_json where they differ:
//!
//! - strings are JavaScript strings: a lone surrogate (`"\ud800"`) parses, survives and
//!   serializes as `\ud800` ([`JsString`]);
//! - numbers are one f64 and print as `Number.prototype.toString` (`1e21`, `1.5e-7`, `1` for
//!   `1.0`, `0` for `-0`, `null` for non-finite) ([`Number`]);
//! - objects keep JavaScript's key order, `__proto__` included as an own key, and a duplicate
//!   key replaces the earlier value in its place ([`Map`]);
//! - parse, serialize, clone, compare and drop use a heap stack, never recursion, so depth is
//!   bounded by memory alone ([`parse`], [`to_string`]);
//! - already-serialized text splices verbatim: [`Raw`] owns canonical text, [`RawRef`] borrows
//!   one value of a validated frame so a translator can pick fields and pass the rest through
//!   without building a tree ([`parse_raw`], [`ObjectWriter`]);
//! - derived `serde::Serialize` types serialize with the same rules ([`ser::to_string`]).

mod access;
pub mod bounded;
mod de;
mod deep;
mod macros;
mod number;
mod object;
mod parse;
mod raw;
mod scan;
pub mod ser;
mod string;
mod to_value;
mod value;
mod write;

pub use access::ValueIndex;
pub use de::{Error as DeError, from_value};
pub use number::{Number, write_number};
pub use object::{Entry, Map, MapKey};
pub use parse::{SyntaxError, parse};
pub use raw::{Entries, Items, Kind, Raw, RawRef, parse_raw};
pub use ser::PreSpliced;
pub use string::{JsString, Units, utf16_len};
pub use to_value::{ToValue, to_value};
pub use value::{Array, Value};
pub use write::{ObjectWriter, to_string, write_js_string, write_str, write_value};

#[cfg(test)]
mod tests;
