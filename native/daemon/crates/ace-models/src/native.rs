// SPDX-License-Identifier: Apache-2.0
//! The field readers every provider catalog parser shares.
//!
//! `z.label` in `packages/models/src/native-schemas.ts` is `z.string().min(1).max(256)`,
//! so these bounds count code points (rule 17), never UTF-8 bytes.

use serde_json::Value;

pub(crate) const LABEL_LIMIT: usize = 256;

/// A provider label: one to 256 code points.
pub(crate) fn label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (1..=LABEL_LIMIT)
        .contains(&text.chars().count())
        .then(|| text.to_owned())
}

/// An array of labels, at most `limit` entries; one bad entry fails the list.
pub(crate) fn labels(value: Option<&Value>, limit: usize) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    if items.len() > limit {
        return None;
    }
    items.iter().map(|item| label(Some(item))).collect()
}

/// A required label on an object.
pub(crate) fn required_label(entry: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    label(entry.get(key))
}

/// A positive integer: serde's `as_u64` rejects negatives, zero and fractions, as
/// zod's `.int().positive()` does.
pub(crate) fn positive_int(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_u64()?;
    (number > 0).then_some(number)
}

/// A boolean field with a default when absent.
pub(crate) fn flag_or(entry: &serde_json::Map<String, Value>, key: &str, default: bool) -> bool {
    entry.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// Why a provider reply cannot be normalized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeError(pub &'static str);

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for NativeError {}
