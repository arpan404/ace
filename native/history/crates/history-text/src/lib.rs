// SPDX-License-Identifier: Apache-2.0

//! Text rules shared with the TypeScript reader and live code (ADR 0207). Each follows its
//! TypeScript source, and `vectors/text.json`, generated from that source, pins the two together:
//!
//! - [`sanitize_user_text`]: `sanitizeUserText` in `@ace/native-session`.
//! - [`session_title`]: `sessionTitle` in `packages/history-import/src/user-text.ts`.
//! - [`summarize_output`]: `summarizeOutput` in `@ace/projection`.
//! - [`js`]: the JavaScript string, date and number behaviour those rely on.

pub mod js;
mod output;
mod sanitize;
mod title;

pub use output::{OutputSummary, output_stream_id, summarize_output};
pub use sanitize::{sanitize_typed_text, sanitize_user_text, strip_ace_origin_marker};
pub use title::session_title;
