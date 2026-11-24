// SPDX-License-Identifier: Apache-2.0
//! The daemon's event store (ADR 0222). Phase 1a: the connection the TypeScript store runs
//! on, so that every connection to the event database in the daemon process uses this one
//! SQLite. Native reads and the writer join here in later phases; a Rust engine calls this
//! crate directly.

pub mod reads;
#[allow(unsafe_code)]
pub mod sqlite;
pub mod stmt_cache;
pub mod writer;

pub use sqlite::{Connection, Error, ErrorKind, OpenOptions, Result, Statement, Value};
