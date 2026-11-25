// SPDX-License-Identifier: Apache-2.0
//! The projection fold in Rust (phase 5.1): `updateThread` and `isSidebarEvent` from
//! `packages/projection/src/index.ts`, and the thread column encoders (5.3b) from
//! `apps/daemon/src/thread-columns.ts`.

pub mod attention;
mod columns;
mod strip;
mod thread;

pub use columns::{
    Column, ColumnChanges, ColumnError, ColumnValue, Part, cold_row_values, column_changes,
    column_value, print_number,
};
pub use strip::{strip, strip_object};
pub use thread::{FoldError, FoldEvent, is_sidebar_event, update_thread};
