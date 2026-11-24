// SPDX-License-Identifier: Apache-2.0
//! The projection fold in Rust (phase 5.1): `updateThread` and `isSidebarEvent` from
//! `packages/projection/src/index.ts`, nothing else from that package.

mod thread;

pub use thread::{FoldError, FoldEvent, is_sidebar_event, update_thread};
