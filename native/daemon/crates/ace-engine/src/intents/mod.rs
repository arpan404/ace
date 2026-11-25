// SPDX-License-Identifier: Apache-2.0
//! The durable intents (E5.4a, `intents.ts`): the indexed headers the workers schedule from,
//! the reads that answer where a command stands, and the lifecycle writes 4c-4f call.

pub mod command;
pub mod header;
pub mod lifecycle;
pub mod query;
pub mod store;

pub use header::{Intent, IntentHeader};
