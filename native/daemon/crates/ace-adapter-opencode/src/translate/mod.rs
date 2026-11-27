// SPDX-License-Identifier: Apache-2.0
//! The opencode translator closure
//! (`packages/adapter-opencode/src/translator.ts` and the modules it reaches
//! by value imports), behind `@ace/engine-api`'s translator interface.

pub mod agents;
pub mod approval_target;
pub mod boundaries;
pub mod cache;
pub mod channels;
pub mod content;
pub mod data;
pub mod detail;
pub mod events;
pub mod interactions;
pub mod projected;
pub mod redaction;
pub mod requests;
pub mod resolve;
pub mod snapshots;
pub mod state;
pub mod tasks;
pub mod tool;
pub mod translator;
pub mod turns;
pub mod usage;

pub use translator::Translator;
