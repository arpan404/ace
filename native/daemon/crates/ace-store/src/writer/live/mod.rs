// SPDX-License-Identifier: Apache-2.0
//! The live write buffer (docs/store/porting-guide.md, task 5.4): delta compaction and the
//! retry rules (5.4a), and the buffer's state (5.4b). The crate holds sequences, sizes, thread
//! keys and deadlines; the shell owns the event objects, the timer and the snapshots, and
//! schedules a returned deadline on the owning thread. Nothing here owns a timer or a thread.

pub mod buffer;
pub mod compact;
pub mod retry;
