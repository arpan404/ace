// SPDX-License-Identifier: Apache-2.0
//! Process supervision behind `@ace/provider-kit`'s process exports
//! (ADR 0223 §2, E2). E0 declares the modules; E2a ports spawning and
//! containment into `spawn`, `contain`, `identity`, `inventory`, `marker`,
//! `reaper`, `stop` and `listing`, and E2b ports framing and protocols into
//! `lines`, `budget`, `flow`, `jsonrpc`, `jsonl` and `sse`.

pub mod budget;
pub mod contain;
pub mod flow;
pub mod identity;
pub mod inventory;
pub mod jsonl;
pub mod jsonrpc;
pub mod lines;
pub mod listing;
pub mod marker;
pub mod reaper;
pub mod spawn;
pub mod sse;
pub mod stop;
