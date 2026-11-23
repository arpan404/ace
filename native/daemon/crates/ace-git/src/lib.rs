// SPDX-License-Identifier: Apache-2.0
//! Git behind `@ace/git`'s interfaces (ADR 0224, docs/git/behaviour.md).
//! The Git CLI stays the executor for every command, run through
//! `ace-supervisor`; `gix` is used only for the ref reads (G1) and the
//! display-only status (G7) the ADR names. G0 declares every module as a
//! stub so parallel builders never edit the same file; each item owns its
//! modules (docs/git/porting-guide.md, "Files per work item") and replaces
//! the stub with the port, keeping the TypeScript's commands, order,
//! environment, parsers and numbers.

pub mod checkpoints;
pub mod core;
pub mod error;
pub mod parse;
pub mod reads;
pub mod refs;
pub mod worktrees_gix;
pub mod writes;
