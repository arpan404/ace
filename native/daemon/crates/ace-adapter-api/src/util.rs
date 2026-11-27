// SPDX-License-Identifier: Apache-2.0
//! The byte helpers every adapter item needs, ported from
//! `packages/provider-kit/src/` with their (b) cases (E0). The TypeScript
//! modules stay for the daemon code that still uses them.

pub mod binary_elision;
pub mod data_url;
pub mod elision;
pub mod js_text;
pub mod native_command_inputs;
pub mod record;

pub use binary_elision::{BINARY_ELISION_CHARS, elided_digest, elided_json, elided_text};
pub use data_url::{Base64DataUrl, base64_data_url, is_base64};
pub use elision::{ElisionLimits, JsonElider};
pub use js_text::is_js_space;
pub use native_command_inputs::{CommandInputsError, native_command_inputs};
pub use record::{NativeRecord, native_record};
