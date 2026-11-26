// SPDX-License-Identifier: Apache-2.0
//! The Rust port of `@ace/redaction` (ADR 0224 §8a, F0), shared by `ace-forge` and
//! `ace-git`. Nothing here keeps what it redacts: the environment matcher's values live in
//! memory for the caller's lifetime and are never written, logged or put in an error.
//!
//! The public surface mirrors `packages/redaction/src/` name for name, so the test cases
//! that moved from its eleven test files need no translation; the secret-key set is the
//! union of `@ace/redaction`'s and the OpenCode adapter's (one owner, see
//! [`is_secret_key`]):
//!
//! - [`Redactor`] builds the lexical rules once (paths, home, host, user, exact environment
//!   values and their JSON-escaped spellings) and redacts literal prose ([`Redactor::text`]),
//!   one JSONL record ([`Redactor::record`]), diagnostics ([`Redactor::diagnostic`]) or a
//!   bounded stream ([`Redactor::stream`]);
//! - [`sensitive_spans`] is the union of the credential patterns, the JSON credential
//!   scanner and the environment matcher, merged so overlapping spellings are replaced once;
//! - [`redact_with_marker`] applies that union with a caller's own placeholder, which is how
//!   the OpenCode adapter redacts with `[redacted]` and cannot drift from the lexical rules.
//!
//! Offsets are byte offsets in the UTF-8 text; every input the daemon redacts is decoded
//! UTF-8. The TypeScript's `.length` bounds count UTF-16 code units, and so do these
//! ([`ace_json::utf16_len`]); a lone surrogate, which JSON can carry, is read as U+FFFD in
//! the string's text (`ace_json::JsString`'s display form).

mod context;
mod embedded_record;
mod embedded_text;
mod environment;
mod json_credentials;
mod literal_spans;
mod patterns;
mod record_environment;
mod redactor;
mod secret_keys;
mod token_counters;

#[cfg(test)]
mod tests;

pub use context::Context;
pub use environment::{EnvironmentMatcher, EnvironmentSpan};
pub use literal_spans::{SensitiveSpan, redact_original_text, redact_with_marker, sensitive_spans};
pub use redactor::{ChunkTooLarge, Redactor, is_sensitive_field};
pub use secret_keys::is_secret_key;
