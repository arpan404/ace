// SPDX-License-Identifier: Apache-2.0
//! In-thread search, as `@ace/search` `thread-query.ts` reads it.

pub mod emit;
pub mod hits;
pub mod query;
pub mod terms;

pub use query::thread_search;
