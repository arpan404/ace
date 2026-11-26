// SPDX-License-Identifier: Apache-2.0
//! The model catalog's first read (`packages/adapter-opencode/src/metadata.ts`).
//! OpenCode 2.4.2 fills a Location's catalog from its providers after the first
//! `GET /api/model`, which answers `data: []`; its own CLI waits for that
//! activation. Discovery reads again every 50 ms until models arrive, bounded at
//! 40 reads and 5 s so a Location with none still answers.
//!
//! A malformed reply is not an empty one: it is validated once and returned as it
//! came. Effort levels come from the catalog's `variants[].id` in the server's
//! order, never from `Object.keys(variants)` or `settings.reasoningEffort`
//! (`packages/models/src/open-code.ts:92`); `session/model.rs` builds the model
//! object from the chosen effort.

use ace_json::Value;

use crate::translate::data::fields;

/// How long the catalog's first read may wait for models.
pub const BUDGET_MS: f64 = 5_000.0;
/// The pause between reads.
pub const POLL_MS: u64 = 50;
/// The most reads one discovery makes.
pub const READS: usize = 40;

/// `withoutModels`: the reply is a well-formed catalog with no models in it. A
/// reply of another shape is malformed, and malformed is not empty.
pub fn empty(reply: &Value) -> bool {
    matches!(fields(reply).get("data"), Some(Value::Array(models)) if models.is_empty())
}

/// Whether to read again after `reads` reads, `elapsed_ms` into the budget:
/// `Some(POLL_MS)` while the reply is empty and both bounds hold.
pub fn again(reads: usize, elapsed_ms: f64, reply: &Value) -> Option<u64> {
    if !empty(reply) || reads >= READS || elapsed_ms >= BUDGET_MS {
        return None;
    }
    Some(POLL_MS)
}

#[cfg(test)]
mod tests;
