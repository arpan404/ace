// SPDX-License-Identifier: Apache-2.0
//! The Cursor translator closure (`packages/adapter-cursor/src/`): the envelope
//! readers, transcript, children, tool views, delta decoding, streamed-answer
//! matching, recovered tails, failure kinds and usage, folded by `translator`.

pub mod api;
pub mod child_fence;
pub mod children;
pub mod delta;
pub mod envelope;
pub mod facts;
pub mod failure_kind;
pub mod notice;
pub mod recovered_tail;
pub mod settle;
pub mod step;
pub mod streamed_answer;
pub mod text;
pub mod tool_events;
pub mod tool_names;
pub mod tool_output;
pub mod tools;
pub mod transcript;
pub mod translator;
pub mod turns;
pub mod usage;

pub use translator::CursorTranslator;

/// What the TypeScript throws when the SDK payload or identity budget is
/// exceeded. The translator fences the turn and never throws on provider data.
#[derive(Debug, thiserror::Error)]
pub enum BudgetError {
    /// A map, list or retained buffer grew past its configured bound.
    #[error("sdk budget exceeded")]
    Exceeded,
}

pub type BudgetResult<T> = Result<T, BudgetError>;
