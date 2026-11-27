// SPDX-License-Identifier: Apache-2.0
//! The reads binding (G3 owns the port). No napi probe remains: the reads are Rust-only under
//! the owner's no-bridge decision, and this module stays declared until the wiring item.
