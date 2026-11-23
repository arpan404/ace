// SPDX-License-Identifier: Apache-2.0
//! The ACP translator closure (E1): pure, synchronous frames to facts.
//! One Rust module per TypeScript module where that reads well.
//! Behaviour lives here; the binding only translates values.

pub mod answers;
pub mod association;
pub mod children;
pub mod completed_tools;
pub mod content;
pub mod data;
pub mod frame_note;
pub mod frame_redaction;
pub mod implicit;
pub mod interactions;
pub mod keys;
pub mod lifecycle;
pub mod prompt_hold;
pub mod quirks;
pub mod requests;
pub mod settlement;
pub mod shell_output;
pub mod shell_settlement;
pub mod state;
pub mod tool_final;
pub mod tool_raw;
pub mod tools;
pub mod translator;
pub mod update;
pub mod update_stream;
pub mod update_tool;

pub use translator::AcpTranslator;
