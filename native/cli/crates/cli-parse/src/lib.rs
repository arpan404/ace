// SPDX-License-Identifier: Apache-2.0
//! One command line read against the command table (ADR 0178 §1–§2). Pure: argv in, the
//! command it names or the usage problem with it.

mod flags;
mod parse;
mod suggest;
mod types;

pub use parse::parse;
pub use suggest::{distance, nearest};
pub use types::{NounOnly, ParseResult, Parsed, Usage};
