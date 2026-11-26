// SPDX-License-Identifier: Apache-2.0
//! JSON credential assignments in *original* syntax (`json-credentials.ts`): a credential
//! key's value is found in raw and JSON-escaped spellings, including across ambiguous prose
//! quotes and damaged keys, and before any lexical replacement can consume the key.
//!
//! The scan is single-pass and cached: value boundaries only move forward, key reads are
//! capped at [`KEY_UNITS`], and a damaged or oversized key fails closed (its value is
//! masked). Structural characters are ASCII, so a byte scan finds the same positions the
//! TypeScript's UTF-16 scan does.

use ace_json::Value;

use crate::secret_keys::is_secret_key;
use crate::token_counters::accounting_counter;

/// The largest key read; a longer candidate is damaged and its value is masked.
pub const KEY_UNITS: usize = 1024;

/// One span to replace; `replacement` keeps the transport's quoting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonCredentialSpan {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

fn is_whitespace(byte: Option<&u8>) -> bool {
    byte.is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
}

fn is_delimiter(byte: Option<&u8>) -> bool {
    is_whitespace(byte) || byte.is_some_and(|byte| matches!(byte, b',' | b';' | b'}' | b']'))
}

/// `JSON.parse(source)`, when it is a string.
fn decoded_key(source: &str) -> Option<String> {
    match ace_json::parse(source) {
        Ok(Value::String(text)) => Some(text.as_str().to_owned()),
        _ => None,
    }
}

/// `JSON.parse('"' + source + '"')` decoded once more, for a key spelled with escapes.
fn decoded_encoded_key(source: &str) -> Option<String> {
    decoded_key(&format!("\"{source}\"")).and_then(|decoded| decoded_key(&decoded))
}

struct Scanner<'a> {
    text: &'a str,
    bytes: &'a [u8],
    raw: isize,
    encoded: isize,
    prose: isize,
    raw_end: isize,
    encoded_end: isize,
    scalar_end: isize,
}

impl<'a> Scanner<'a> {
    fn next_raw_quote(&mut self, open: usize) -> isize {
        if self.raw_end > open as isize {
            return self.raw_end;
        }
        let mut run = 0usize;
        for at in open + 1..self.bytes.len() {
            if self.bytes[at] == b'\\' {
                run += 1;
                continue;
            }
            if self.bytes[at] == b'"' && run.is_multiple_of(2) {
                self.raw_end = at as isize;
                return self.raw_end;
            }
            run = 0;
        }
        self.raw_end = self.bytes.len() as isize;
        self.raw_end
    }

    fn next_encoded_quote(&mut self, open: usize) -> isize {
        if self.encoded_end > open as isize {
            return self.encoded_end;
        }
        let mut run = 0usize;
        for at in open + 1..self.bytes.len() {
            if self.bytes[at] == b'\\' {
                run += 1;
                continue;
            }
            if self.bytes[at] == b'"' && run % 4 == 1 {
                self.encoded_end = at as isize;
                return self.encoded_end;
            }
            run = 0;
        }
        self.encoded_end = self.bytes.len() as isize;
        self.encoded_end
    }

    fn spans(mut self) -> Vec<JsonCredentialSpan> {
        let mut spans = Vec::new();
        let mut slashes = 0usize;
        let mut at = 0usize;
        while at < self.bytes.len() {
            let byte = self.bytes[at];
            if byte == b'\\' {
                slashes += 1;
                at += 1;
                continue;
            }
            let run = slashes;
            slashes = 0;
            if byte != b'"' {
                at += 1;
                continue;
            }
            let escaped = run % 2 == 1;
            let opener = if escaped { self.encoded } else { self.raw };
            // Prose backslashes need not share JSON's delimiter encoding: keep every quote as
            // an opener candidate rather than trusting parity alone.
            let prose_opener = self.prose;
            self.prose = at as isize;
            if run.is_multiple_of(2) {
                self.raw = at as isize;
            }
            if run % 4 == 1 {
                self.encoded = at as isize;
            }
            let mut value = at + 1;
            while is_whitespace(self.bytes.get(value)) {
                value += 1;
            }
            if self.bytes.get(value) != Some(&b':') || (opener < 0 && prose_opener < 0) {
                at += 1;
                continue;
            }
            let start = opener - if escaped { 1 } else { 0 };
            let prose_end = at as isize - if escaped { 1 } else { 0 };
            let key_end = at as isize + 1;
            let oversized = (opener >= 0 && key_end - start > KEY_UNITS as isize)
                || (prose_opener >= 0 && prose_end - prose_opener >= KEY_UNITS as isize);
            let canonical_key =
                if opener >= 0 && start >= 0 && key_end - start <= KEY_UNITS as isize {
                    let source = &self.text[start as usize..=at];
                    if escaped {
                        decoded_encoded_key(source)
                    } else {
                        decoded_key(source)
                    }
                } else {
                    None
                };
            let prose_key = if prose_opener >= 0 && prose_end - prose_opener < KEY_UNITS as isize {
                let inner_start = (prose_opener + 1) as usize;
                let inner_end = prose_end.max(prose_opener + 1) as usize;
                decoded_key(&format!("\"{}\"", &self.text[inner_start..inner_end]))
            } else {
                None
            };
            let key = match &prose_key {
                Some(prose) if is_secret_key(prose) => prose_key.clone(),
                _ => canonical_key.clone().or(prose_key.clone()),
            };
            // A decoded ordinary suffix cannot vouch for a longer damaged candidate. Missing
            // openers are not candidates; every present candidate must decode.
            let damaged = oversized
                || (opener >= 0 && canonical_key.is_none())
                || (prose_opener >= 0 && prose_key.is_none());
            if !damaged && key.as_ref().is_some_and(|key| !is_secret_key(key)) {
                at += 1;
                continue;
            }
            value += 1;
            while is_whitespace(self.bytes.get(value)) {
                value += 1;
            }
            match self.bytes.get(value) {
                Some(b'"') => {
                    let end = self.next_raw_quote(value);
                    if end > value as isize + 1 {
                        spans.push(JsonCredentialSpan {
                            start: value + 1,
                            end: end as usize,
                            replacement: String::from("<SECRET>"),
                        });
                    }
                }
                Some(b'\\') if self.bytes.get(value + 1) == Some(&b'"') => {
                    let end = self.next_encoded_quote(value + 1);
                    let content_end = if end < self.bytes.len() as isize {
                        end - 1
                    } else {
                        end
                    };
                    if content_end > value as isize + 2 {
                        spans.push(JsonCredentialSpan {
                            start: value + 2,
                            end: content_end as usize,
                            replacement: String::from("<SECRET>"),
                        });
                    }
                }
                Some(b'{') | Some(b'[') => {
                    // Containers retain original key classification in the structured owner.
                }
                _ => {
                    if self.scalar_end < value as isize {
                        self.scalar_end = value as isize;
                        while (self.scalar_end as usize) < self.bytes.len()
                            && !is_delimiter(self.bytes.get(self.scalar_end as usize))
                        {
                            self.scalar_end += 1;
                        }
                    }
                    let scalar_end = self.scalar_end;
                    if value as isize >= scalar_end {
                        at += 1;
                        continue;
                    }
                    if !damaged
                        && let Some(key) = &key
                        && scalar_end - value as isize <= KEY_UNITS as isize
                        && let Ok(scalar) = ace_json::parse(&self.text[value..scalar_end as usize])
                        && accounting_counter(key, &scalar)
                    {
                        at += 1;
                        continue;
                    }
                    spans.push(JsonCredentialSpan {
                        start: value,
                        end: scalar_end as usize,
                        replacement: String::from(if escaped {
                            "\\\"<SECRET>\\\""
                        } else {
                            "\"<SECRET>\""
                        }),
                    });
                }
            }
            at += 1;
        }
        spans
    }
}

/// The credential values `text` spells as JSON, in original syntax.
pub fn json_credential_spans(text: &str) -> Vec<JsonCredentialSpan> {
    Scanner {
        text,
        bytes: text.as_bytes(),
        raw: -1,
        encoded: -1,
        prose: -1,
        raw_end: -1,
        encoded_end: -1,
        scalar_end: -1,
    }
    .spans()
}

#[cfg(test)]
mod tests {
    use super::json_credential_spans;
    use crate::literal_spans::redact_original_text;

    fn redacted(text: &str) -> String {
        redact_original_text(text, None)
    }

    #[test]
    fn prose_quotes_cannot_hide_a_following_json_credential() {
        for input in [
            r#"before " {"token":"OPAQUE_CREDENTIAL"} after"#,
            r#"before "one" " {"token":"OPAQUE_CREDENTIAL"} after"#,
            r#"before "one" "two" " {"token":"OPAQUE_CREDENTIAL"} after"#,
            r#"before {"note":"a \"quoted\" value"} " {"token":"OPAQUE_CREDENTIAL"} after"#,
            r#"before " {"note":"a \"quoted\" value","token":"OPAQUE_CREDENTIAL"} after"#,
        ] {
            let safe = redacted(input);
            assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{input} -> {safe}");
            assert!(safe.contains("<SECRET>"), "{input} -> {safe}");
        }
    }

    #[test]
    fn json_credential_strings_are_removed_without_losing_ordinary_fields() {
        for input in [
            r#"before {"prefix_token_suffix":"OPAQUE_CREDENTIAL","visible":"ok"} after"#,
            r#"before {"api\u005fkey" : "OPAQUE_CREDENTIAL","visible":"ok"} after"#,
            r#"before {"authorization":"OPAQUE_CREDENTIAL \"private quote\" tail","visible":"ok"} after"#,
        ] {
            let safe = redacted(input);
            assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{input} -> {safe}");
            assert!(!safe.contains("private quote"), "{input} -> {safe}");
            assert!(safe.contains(r#""<SECRET>""#), "{input} -> {safe}");
            assert!(safe.contains(r#""visible":"ok""#), "{input} -> {safe}");
        }
    }

    #[test]
    fn ordinary_json_string_values_are_not_treated_as_credential_keys() {
        let input = r#"{"note":"token secret authorization", "visible":"ok"}"#;
        assert_eq!(redacted(input), input);
    }

    #[test]
    fn a_long_credential_key_still_masks_its_value() {
        let key = "token ".repeat(8_000);
        let input = format!("{{\"{key}\":\"OPAQUE_CREDENTIAL\"}}");
        assert_eq!(
            redacted(&input),
            input.replace("OPAQUE_CREDENTIAL", "<SECRET>")
        );
    }

    #[test]
    fn an_oversized_key_cannot_hide_a_credential() {
        let input = format!("{{\"token{0}\":\"OPAQUE_CREDENTIAL\"}}", "x".repeat(8_000));
        let safe = redacted(&input);
        assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{safe}");
        assert!(safe.contains(r#""<SECRET>""#), "{safe}");
    }

    #[test]
    fn bare_scalar_credentials_are_masked_while_usage_counters_survive() {
        let safe = redacted(r#"{"inputTokens":12,"password":OPAQUE_CREDENTIAL,"visible":7}"#);
        assert!(!safe.contains("OPAQUE_CREDENTIAL"), "{safe}");
        assert!(safe.contains(r#""inputTokens":12"#), "{safe}");
        assert!(safe.contains(r#""visible":7"#), "{safe}");
    }

    #[test]
    fn mixed_key_delimiters_preserve_an_ordinary_value() {
        for input in [
            r#"before \"note":"ordinary" after"#,
            r#"before "note\": "ordinary" after"#,
        ] {
            assert_eq!(redacted(input), input);
        }
    }

    #[test]
    fn a_damaged_key_cannot_use_an_ordinary_numeric_suffix_to_bypass_redaction() {
        let input = r#"before "token\q\"inputTokens":12 after"#;
        assert_eq!(
            redacted(input),
            r#"before "token\q\"inputTokens":"<SECRET>" after"#
        );
    }

    #[test]
    fn json_credential_spans_report_the_value_not_its_key() {
        let spans = json_credential_spans(r#"{"token":"opaque-value"}"#);
        assert_eq!(spans.len(), 1);
        assert_eq!(
            &r#"{"token":"opaque-value"}"#[spans[0].start..spans[0].end],
            "opaque-value"
        );
    }
}
