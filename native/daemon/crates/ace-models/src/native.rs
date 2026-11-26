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

#[cfg(test)]
mod tests {
    //! The one label rule the provider parsers share: one to 256 code points
    //! (`native-schemas.ts`'s `id`), an optional list bound, and positive integers.

    use super::*;
    use serde_json::json;

    #[test]
    fn a_label_is_one_to_256_code_points() {
        assert_eq!(label(Some(&json!("model"))), Some("model".to_owned()));
        assert_eq!(label(Some(&json!(""))), None);
        assert_eq!(label(Some(&json!(5))), None);
        assert_eq!(label(None), None);
        // The bound counts code points: 256 emoji pass, 257 do not (rule 17).
        assert!(label(Some(&json!("🚀".repeat(256)))).is_some());
        assert!(label(Some(&json!("🚀".repeat(257)))).is_none());
    }

    #[test]
    fn a_label_list_is_all_or_nothing_up_to_its_limit() {
        assert_eq!(
            labels(Some(&json!(["a", "b"])), 2),
            Some(vec!["a".to_owned(), "b".to_owned()])
        );
        assert_eq!(labels(Some(&json!(["a", "b", "c"])), 2), None);
        assert_eq!(labels(Some(&json!(["a", 7])), 2), None);
        assert_eq!(labels(Some(&json!(["a", ""])), 2), None);
        assert_eq!(labels(Some(&json!("a")), 2), None);
        assert_eq!(labels(None, 2), None);
    }

    #[test]
    fn positive_integers_reject_zero_fractions_and_negatives() {
        assert_eq!(positive_int(Some(&json!(1))), Some(1));
        assert_eq!(positive_int(Some(&json!(0))), None);
        assert_eq!(positive_int(Some(&json!(1.5))), None);
        assert_eq!(positive_int(Some(&json!(-1))), None);
        assert_eq!(positive_int(Some(&json!("5"))), None);
        assert_eq!(positive_int(None), None);
    }

    #[test]
    fn a_defaulted_flag_reads_only_a_boolean() {
        let entry = json!({ "hidden": false, "broken": "true" });
        let entry = entry.as_object().cloned().unwrap_or_default();
        assert!(!flag_or(&entry, "hidden", true));
        assert!(flag_or(&entry, "broken", true));
        assert!(flag_or(&entry, "absent", true));
    }
}
