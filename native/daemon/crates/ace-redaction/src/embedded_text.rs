// SPDX-License-Identifier: Apache-2.0
//! Prose with embedded records (`embedded-text.ts`): one forward scan over the original
//! text, where a record is decoded from its own bytes and scrubbed by its owner, a damaged
//! record omits the remaining text, and a secret spanning a segment boundary is masked as a
//! whole. Coloured CLI stderr and bracketed words (`[DEP0040]`) stay readable prose.

use regex::Regex;
use std::sync::LazyLock;

use crate::embedded_record::{consumed_record_end, embedded_record_end};
use crate::environment::EnvironmentMatcher;
use crate::json_credentials::{JsonCredentialSpan, json_credential_spans};
use crate::literal_spans::{SensitiveSpan, sensitive_spans};

/// A bracketed word is prose, as in Node's own warnings: it holds no quote, brace or nested
/// bracket, so it cannot hide a record.
#[allow(clippy::expect_used)]
static PROSE_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[[A-Za-z][A-Za-z0-9_ .:#/-]{0,63}\]").expect("the prose-tag pattern compiles")
});

const OMITTED: &str = "<INVALID STRUCTURED DATA OMITTED>";
const OVERSIZED: &str = "<OVERSIZED REDACTED>";

/// `text` with its embedded records scrubbed and its prose redacted.
pub fn redact_embedded_text<F, G>(
    text: &str,
    scrub_plain: &F,
    scrub_record: &mut G,
    environment: Option<&EnvironmentMatcher>,
) -> String
where
    F: Fn(&str) -> String,
    G: FnMut(&str) -> String,
{
    let bytes = text.as_bytes();
    let spans = sensitive_spans(text, environment);
    let assignments: Vec<JsonCredentialSpan> = json_credential_spans(text);
    let mut span_index = 0usize;
    let mut assignment_index = 0usize;
    let mut parts: Vec<String> = Vec::new();
    let mut plain = 0usize;
    let mut start = 0usize;
    while start < bytes.len() {
        while spans.get(span_index).is_some_and(|span| span.start < start) {
            span_index += 1;
        }
        if spans
            .get(span_index)
            .is_some_and(|span| span.start == start)
        {
            let sensitive = spans[span_index].clone();
            span_index += 1;
            let mut end = consumed_record_end(text, start, sensitive.end);
            let mut replacement = sensitive.replacement;
            while let Some(next) = spans.get(span_index) {
                if next.start >= end {
                    break;
                }
                // Covered spans cannot change omitted syntax. Only scan a new suffix when a
                // span extends coverage; this cursor never moves backwards.
                if next.end > end {
                    end = consumed_record_end(text, end, next.end);
                }
                if next.replacement.as_ref() == "<SECRET>" {
                    replacement = std::borrow::Cow::Borrowed("<SECRET>");
                }
                span_index += 1;
            }
            parts.push(scrub_plain(&text[plain..start]));
            parts.push(replacement.into_owned());
            start = end;
            plain = start;
            continue;
        }
        let first = bytes[start];
        if first != b'{' && first != b'[' && first != b'"' {
            start += 1;
            continue;
        }
        // ESC [ introduces a terminal control sequence (colours in CLI stderr), not a record.
        if first == b'[' && start > 0 && bytes[start - 1] == 0x1b {
            start += 1;
            continue;
        }
        // A bracketed word (`[DEP0040]`, `[AbortSignal]`) is prose, as in Node's warnings.
        if first == b'[' && PROSE_TAG.is_match(&text[start..(start + 66).min(text.len())]) {
            start += 1;
            continue;
        }
        parts.push(scrub_plain(&text[plain..start]));
        let end = embedded_record_end(text, start) - 1;
        let mut crossing: Option<SensitiveSpan> = None;
        while let Some(sensitive) = spans.get(span_index) {
            if sensitive.start > end {
                break;
            }
            if sensitive.end > end + 1 {
                crossing = Some(sensitive.clone());
                break;
            }
            span_index += 1;
        }
        if let Some(crossing) = crossing {
            // The span begins inside this record. Resume scanning original syntax after its
            // closer, so a consumed next opener retains its enclosing end.
            let mut resume = consumed_record_end(text, end + 1, crossing.end);
            let mut replacement = crossing.replacement;
            span_index += 1;
            while let Some(next) = spans.get(span_index) {
                if next.start >= resume {
                    break;
                }
                if next.end > resume {
                    resume = consumed_record_end(text, resume, next.end);
                }
                if next.replacement.as_ref() == "<SECRET>" {
                    replacement = std::borrow::Cow::Borrowed("<SECRET>");
                }
                span_index += 1;
            }
            parts.push(replacement.into_owned());
            start = resume;
            plain = start;
            continue;
        }
        let original = &text[start..=end];
        if ace_json::parse(original).is_err() {
            // Validation before redaction distinguishes damaged embedded data from
            // readable prose without guessing at the value's structure.
            parts.push(String::from(OMITTED));
            return parts.join("");
        }
        // A prose quote can leave a credential value as a standalone string token. Preserve
        // original assignment spans before decoding that token; use the assignment spans
        // themselves, not a merged lexical span that might also consume a prefix.
        let mut record_parts: Vec<String> = Vec::new();
        let mut record_plain = start;
        while assignments
            .get(assignment_index)
            .is_some_and(|span| span.start < start)
        {
            assignment_index += 1;
        }
        if first == b'"' {
            while let Some(assignment) = assignments.get(assignment_index) {
                if assignment.start > end || assignment.end > end + 1 {
                    break;
                }
                if assignment.end > record_plain {
                    if assignment.start >= record_plain {
                        record_parts.push(text[record_plain..assignment.start].to_owned());
                        record_parts.push(assignment.replacement.clone());
                    }
                    record_plain = assignment.end;
                }
                assignment_index += 1;
            }
        }
        let record = if record_parts.is_empty() {
            original.to_owned()
        } else {
            record_parts.push(text[record_plain..=end].to_owned());
            record_parts.join("")
        };
        parts.push(scrub_record(&record));
        start = end + 1;
        plain = start;
    }
    parts.push(scrub_plain(&text[plain..]));
    // Reassembled quoted prose can contain a configured secret spanning scan segments.
    let result = scrub_plain(&parts.join(""));
    if ace_json::utf16_len(&result) > 262_144 {
        String::from(OVERSIZED)
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::redact_embedded_text;
    use crate::environment::EnvironmentMatcher;
    use crate::literal_spans::redact_original_text;

    fn redact(text: &str) -> String {
        let scrub = |text: &str| redact_original_text(text, None);
        let record = |record: &str| record.to_owned();
        redact_embedded_text(text, &scrub, &mut record.clone(), None)
    }

    #[test]
    fn embedded_records_are_passed_to_their_owner_and_prose_is_scrubbed() {
        let scrub = |text: &str| redact_original_text(text, None);
        let mut seen: Vec<String> = Vec::new();
        let mut record = |record: &str| {
            seen.push(record.to_owned());
            String::from("<RECORD>")
        };
        let text = r#"before {"token":"opaque"} ghp_12345678901234567890 after"#;
        let safe = redact_embedded_text(text, &scrub, &mut record, None);
        assert_eq!(seen, vec![String::from(r#"{"token":"opaque"}"#)]);
        assert_eq!(safe, "before <RECORD> <SECRET> after");
    }

    #[test]
    fn a_damaged_record_omits_the_remaining_text() {
        assert_eq!(
            redact(r#"before {"note": } after"#),
            "before <INVALID STRUCTURED DATA OMITTED>"
        );
    }

    #[test]
    fn coloured_prose_and_bracketed_words_stay_readable() {
        let line = "\u{1b}[31mERROR\u{1b}[0m api_key=OPAQUE_STDERR_CREDENTIAL";
        let safe = redact(line);
        assert!(safe.contains("ERROR"), "{safe}");
        assert!(!safe.contains("OPAQUE_STDERR_CREDENTIAL"), "{safe}");
        let warning = r#"(node:1) [DEP0005] {"password":"opaque-value"}"#;
        let safe = redact(warning);
        assert!(safe.contains("[DEP0005]"), "{safe}");
        assert!(!safe.contains("opaque-value"), "{safe}");
    }

    #[test]
    fn a_configured_value_consuming_a_record_opener_cannot_expose_its_contents() {
        let environment = EnvironmentMatcher::new(&["lead{\"credentials\":"]);
        let scrub = |text: &str| redact_original_text(text, Some(&environment));
        let mut record = |record: &str| record.to_owned();
        let text = r#"lead{"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}"#;
        let safe = redact_embedded_text(text, &scrub, &mut record, Some(&environment));
        assert!(!safe.contains("OPAQUE_CONTAINER_CREDENTIAL"), "{safe}");
        assert!(safe.contains("<ENV>"), "{safe}");
    }

    #[test]
    fn a_secret_spanning_a_quoted_token_is_masked_as_a_whole() {
        let environment = EnvironmentMatcher::new(&["\"OPAQUE_CROSS_CREDENTIAL\"} tail"]);
        let scrub = |text: &str| redact_original_text(text, Some(&environment));
        let mut record = |record: &str| record.to_owned();
        let text = r#"request failed: {"payload":"OPAQUE_CROSS_CREDENTIAL"} tail"#;
        let safe = redact_embedded_text(text, &scrub, &mut record, Some(&environment));
        assert!(!safe.contains("OPAQUE"), "{safe}");
        assert!(safe.contains("request failed"), "{safe}");
        assert!(safe.contains("<ENV>"), "{safe}");
    }
}
