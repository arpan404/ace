// SPDX-License-Identifier: Apache-2.0
//! The durable queue (E5.4a): its record, its statements, its client views, the snooze wake,
//! stale-input retirement and the fold hooks E5.3 calls.

pub mod deadline;
pub mod fold_hooks;
pub mod messages;
pub mod page;
pub mod patch;
pub mod record;
pub mod stale;
pub mod store;
pub mod wake;
