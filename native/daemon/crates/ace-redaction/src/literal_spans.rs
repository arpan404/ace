// SPDX-License-Identifier: Apache-2.0
//! The union of every lexically visible secret (`literal-spans.ts`): credential patterns,
//! JSON credential assignments and configured environment values, merged so overlapping
//! spellings are replaced once. A match arriving later that starts before an earlier one is
//! merged into it, so `password=` patterns cannot be shortened by their own value.

use std::borrow::Cow;

use crate::environment::EnvironmentMatcher;
use crate::json_credentials::json_credential_spans;
use crate::patterns::patterns;

/// One span to replace, as byte offsets and the text that replaces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SensitiveSpan {
    pub start: usize,
    pub end: usize,
    pub replacement: Cow<'static, str>,
}

#[derive(Debug, Clone)]
struct ScanMatch {
    start: usize,
    end: usize,
    replacement: Cow<'static, str>,
}

fn pattern_matches(text: &str) -> Vec<Vec<ScanMatch>> {
    patterns()
        .iter()
        .map(|pattern| {
            pattern
                .pattern
                .captures_iter(text)
                .filter_map(|captures| {
                    let whole = captures.get(0)?;
                    let start = match pattern.prefix {
                        Some(offset) => {
                            whole.start()
                                + captures.get(1).map_or(0, |group| group.as_str().len())
                                + offset
                        }
                        None => whole.start(),
                    };
                    Some(ScanMatch {
                        start,
                        end: whole.end().saturating_sub(pattern.suffix),
                        replacement: Cow::Borrowed("<SECRET>"),
                    })
                })
                .collect()
        })
        .collect()
}

/// Every sensitive span of `text`, merged, in order: the credential patterns, the JSON
/// credential scanner and `environment`'s exact values.
pub fn sensitive_spans(text: &str, environment: Option<&EnvironmentMatcher>) -> Vec<SensitiveSpan> {
    let env = environment
        .map(|matcher| matcher.spans(text))
        .unwrap_or_default();
    let mut scans = pattern_matches(text);
    scans.push(
        json_credential_spans(text)
            .into_iter()
            .map(|span| ScanMatch {
                start: span.start,
                end: span.end,
                replacement: Cow::Owned(span.replacement),
            })
            .collect(),
    );
    let mut cursors = vec![0usize; scans.len()];
    let mut env_index = 0usize;
    let mut spans: Vec<SensitiveSpan> = Vec::new();
    loop {
        let mut start = env.get(env_index).map_or(usize::MAX, |span| span.start);
        for (list, cursor) in scans.iter().zip(cursors.iter()) {
            if let Some(found) = list.get(*cursor) {
                start = start.min(found.start);
            }
        }
        if start == usize::MAX {
            return spans;
        }
        let mut end = start + 1;
        let mut replacement: Cow<'static, str> = Cow::Borrowed("<ENV>");
        let mut preferred: Option<ScanMatch> = None;
        let mut extended = true;
        while extended {
            extended = false;
            while let Some(span) = env.get(env_index) {
                if span.start >= end {
                    break;
                }
                if span.end > end {
                    end = span.end;
                    extended = true;
                }
                env_index += 1;
            }
            for (list, cursor) in scans.iter().zip(cursors.iter_mut()) {
                while let Some(found) = list.get(*cursor) {
                    if found.start >= end {
                        break;
                    }
                    let wider = preferred.as_ref().is_none_or(|current| {
                        found.start <= current.start && found.end >= current.end
                    });
                    if wider {
                        preferred = Some(found.clone());
                    }
                    if found.end > end {
                        end = found.end;
                        extended = true;
                    }
                    replacement = Cow::Borrowed("<SECRET>");
                    *cursor += 1;
                }
            }
        }
        let chosen = match preferred {
            Some(found) if found.start == start && found.end == end => found.replacement,
            _ => replacement,
        };
        spans.push(SensitiveSpan {
            start,
            end,
            replacement: chosen,
        });
    }
}

/// `text` with every sensitive span replaced, as the lexical redactor does.
pub fn redact_original_text(text: &str, environment: Option<&EnvironmentMatcher>) -> String {
    let spans = sensitive_spans(text, environment);
    if spans.is_empty() {
        return text.to_owned();
    }
    let mut parts = String::with_capacity(text.len());
    let mut start = 0;
    for span in spans {
        if span.start < start || span.end > text.len() {
            continue;
        }
        parts.push_str(&text[start..span.start]);
        parts.push_str(&span.replacement);
        start = span.end;
    }
    parts.push_str(&text[start..]);
    parts
}

#[cfg(test)]
mod tests {
    use super::{redact_original_text, sensitive_spans};
    use crate::environment::EnvironmentMatcher;

    #[test]
    fn credential_shapes_are_masked_with_the_secret_marker() {
        assert_eq!(redact_original_text("token=OPAQUE", None), "<SECRET>");
        assert_eq!(
            redact_original_text("say Bearer opaque-token now", None),
            "say <SECRET> now"
        );
        assert!(!redact_original_text("ghp_12345678901234567890", None).contains("ghp_"));
    }

    #[test]
    fn an_environment_value_is_masked_with_the_environment_marker() {
        let matcher = EnvironmentMatcher::new(&["opaque-key-value"]);
        assert_eq!(
            redact_original_text("reason: opaque-key-value", Some(&matcher)),
            "reason: <ENV>"
        );
    }

    #[test]
    fn a_quoted_password_keeps_its_record_delimiters() {
        let spans = sensitive_spans(r#"before "password":"opaque" after"#, None);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].replacement.as_ref(), "<SECRET>");
        assert_eq!(
            redact_original_text(r#"before "password":"opaque" after"#, None),
            r#"before "password":"<SECRET>" after"#
        );
    }

    #[test]
    fn an_env_match_cannot_shorten_a_quoted_credential() {
        let matcher = EnvironmentMatcher::new(&["Authorization"]);
        assert_eq!(
            redact_original_text(
                r#"before Authorization: "OPAQUE_HEADER_CREDENTIAL" after"#,
                Some(&matcher)
            ),
            "before <SECRET> after"
        );
    }

    #[test]
    fn plain_text_is_returned_unchanged() {
        assert_eq!(
            redact_original_text("ordinary prose", None),
            "ordinary prose"
        );
    }
}
