// SPDX-License-Identifier: Apache-2.0
//! The live buffer's pure parts (docs/store/porting-guide.md, task 5.4a): delta compaction and
//! the retry rules. The buffer's bookkeeping and its 75 ms and 1 s deadlines stay TypeScript
//! until 5.4b, and a deadline this crate returns is data for the caller, never a timer.

pub mod compact;
pub mod retry;
