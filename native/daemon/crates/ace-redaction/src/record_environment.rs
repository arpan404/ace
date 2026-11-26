// SPDX-License-Identifier: Apache-2.0
//! Exact configured values inside one JSON record's *original* syntax
//! (`record-environment.ts`). String contents and keys stay original until the recursive
//! clean, which classifies keys first; if decoding would destroy an exact match, the value
//! or its key's record is omitted, and a match crossing a string boundary omits the record
//! rather than guessing at how to repair its syntax.

use crate::environment::EnvironmentMatcher;

/// One string token in a record: its quotes, and whether a colon follows it (a key).
#[derive(Debug, Clone, Copy)]
struct QuotedSpan {
    start: usize,
    end: usize,
    key: bool,
}

fn is_whitespace(byte: Option<&u8>) -> bool {
    byte.is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
}

/// `record` with every exact configured value masked as `"<ENV>"`, in place-safe syntax.
pub fn redact_record_environment(record: &str, environment: Option<&EnvironmentMatcher>) -> String {
    let Some(environment) = environment else {
        return record.to_owned();
    };
    if environment.values().is_empty() {
        return record.to_owned();
    }
    let bytes = record.as_bytes();
    let mut strings: Vec<QuotedSpan> = Vec::new();
    let mut start = 0usize;
    while start < bytes.len() {
        if bytes[start] != b'"' {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < bytes.len() {
            if bytes[end] == b'\\' {
                end += 2;
            } else if bytes[end] == b'"' {
                break;
            } else {
                end += 1;
            }
        }
        let mut after = end + 1;
        while after < bytes.len() && is_whitespace(bytes.get(after)) {
            after += 1;
        }
        strings.push(QuotedSpan {
            start,
            end: end + 1,
            key: bytes.get(after) == Some(&b':'),
        });
        start = end + 1;
    }
    let mut parts: Vec<String> = Vec::new();
    let mut plain = 0usize;
    let mut quoted = 0usize;
    for span in environment.spans(record) {
        if span.start < plain {
            continue;
        }
        while strings
            .get(quoted)
            .is_some_and(|entry| entry.end <= span.start)
        {
            quoted += 1;
        }
        let first = strings.get(quoted).copied();
        let remains_known = {
            let mut quoted_text = String::with_capacity(span.end - span.start + 2);
            quoted_text.push('"');
            quoted_text.push_str(&record[span.start..span.end]);
            quoted_text.push('"');
            match ace_json::parse(&quoted_text) {
                // An escape cut by the match cannot safely be repaired in place.
                Ok(ace_json::Value::String(text)) => environment.values().contains(text.as_str()),
                _ => false,
            }
        };
        if let Some(first) = first
            && first.key
            && span.start >= first.start
            && span.end <= first.end
        {
            if remains_known {
                continue;
            }
            return String::from("\"<ENV>\"");
        }
        if let Some(first) = first
            && span.start > first.start
            && span.end < first.end
        {
            // Transport escapes that decode to a configured value remain exact matches for
            // recursive cleaning, including embedded JSON key checks.
            if remains_known {
                continue;
            }
            parts.push(record[plain..first.start].to_owned());
            parts.push(String::from("\"<ENV>\""));
            plain = first.end;
            continue;
        }
        if let Some(first) = first
            && span.start > first.start
            && span.start < first.end
        {
            return String::from("\"<ENV>\"");
        }
        let mut last = quoted;
        while strings.get(last).is_some_and(|entry| entry.end < span.end) {
            last += 1;
        }
        if let Some(boundary) = strings.get(last)
            && span.end > boundary.start
            && span.end < boundary.end
        {
            return String::from("\"<ENV>\"");
        }
        parts.push(record[plain..span.start].to_owned());
        parts.push(String::from("\"<ENV>\""));
        plain = span.end;
    }
    parts.push(record[plain..].to_owned());
    parts.join("")
}

#[cfg(test)]
mod tests {
    use super::redact_record_environment;
    use crate::environment::EnvironmentMatcher;

    #[test]
    fn a_value_that_decodes_to_the_configured_value_stays_for_recursive_cleaning() {
        let matcher = EnvironmentMatcher::new(&["opaque-echoed"]);
        let record = r#"{"note":"opaque-echoed","code":7}"#;
        assert_eq!(redact_record_environment(record, Some(&matcher)), record);
        let escaped = r#"{"payload":"left{ \"value\" }right","code":7}"#;
        let matcher = EnvironmentMatcher::new(&["left{ \"value\" }right"]);
        assert_eq!(redact_record_environment(escaped, Some(&matcher)), escaped);
    }

    #[test]
    fn a_match_crossing_a_string_boundary_omits_the_record() {
        let matcher = EnvironmentMatcher::new(&["opaque\"tail"]);
        let safe = redact_record_environment(r#"{"note":"opaque"tail"}"#, Some(&matcher));
        assert_eq!(safe, "\"<ENV>\"");
    }

    #[test]
    fn a_configured_key_keeps_its_record_so_recursive_cleaning_classifies_it() {
        let matcher = EnvironmentMatcher::new(&["credentials"]);
        assert_eq!(
            redact_record_environment(r#"{"credentials":{"login":"x"}}"#, Some(&matcher)),
            r#"{"credentials":{"login":"x"}}"#
        );
    }

    #[test]
    fn no_matcher_returns_the_record_unchanged() {
        assert_eq!(
            redact_record_environment(r#"{"note":"x"}"#, None),
            r#"{"note":"x"}"#
        );
        let empty = EnvironmentMatcher::new(&[""]);
        assert_eq!(
            redact_record_environment(r#"{"note":"x"}"#, Some(&empty)),
            r#"{"note":"x"}"#
        );
    }
}
