// SPDX-License-Identifier: Apache-2.0
//! The end of an original enclosing record (`embedded-record.ts`): the text that a record
//! opener starts, including damaged or unclosed input. Callers validate complete records
//! before decoding; depth work stays bounded.

/// End (exclusive) of the record starting at `start`. A quote's end is its closing quote, a
/// container's is its matching closer, and an unclosed one runs to the text's end. A stack
/// deeper than 32 gives up and returns the whole text, as the TypeScript does.
pub fn embedded_record_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let Some(first) = bytes.get(start) else {
        return text.len();
    };
    let mut quoted = *first == b'"';
    let mut escaped = false;
    let mut stack: Vec<u8> = if quoted {
        Vec::new()
    } else if *first == b'{' {
        vec![b'}']
    } else {
        vec![b']']
    };
    let mut end = start + 1;
    while end < bytes.len() {
        let byte = bytes[end];
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
                if stack.is_empty() {
                    break;
                }
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b'{' || byte == b'[' {
            if stack.len() >= 32 {
                return text.len();
            }
            stack.push(if byte == b'{' { b'}' } else { b']' });
        } else if (byte == b'}' || byte == b']') && (stack.pop() != Some(byte) || stack.is_empty())
        {
            break;
        }
        end += 1;
    }
    (end + 1).min(text.len())
}

/// The end (exclusive) that consuming a record opener must also consume: the original
/// enclosing record, so its now-unclassified credential value cannot become ordinary data.
pub fn consumed_record_end(text: &str, start: usize, end: usize) -> usize {
    let bytes = text.as_bytes();
    let mut end = end;
    let mut cursor = start;
    while cursor < end {
        let byte = bytes[cursor];
        // This cursor is in unquoted prose. Backslashes cannot escape openers;
        // `embedded_record_end` handles escapes only after entering a quoted token.
        if byte != b'{' && byte != b'[' && byte != b'"' {
            cursor += 1;
            continue;
        }
        // ESC [ introduces a terminal control sequence, not a record.
        if byte == b'[' && cursor > 0 && bytes[cursor - 1] == 0x1b {
            cursor += 1;
            continue;
        }
        if byte == b'{' {
            let mut next = cursor + 1;
            while next < bytes.len() && matches!(bytes[next], b' ' | b'\t' | b'\n' | b'\r') {
                next += 1;
            }
            // JSON-escaped transport prose is handled after its surrounding string is
            // decoded, rather than interpreting its escaped quotes as raw keys.
            if next < bytes.len() && bytes[next] != b'"' && bytes[next] != b'}' {
                cursor += 1;
                continue;
            }
        }
        let record_end = embedded_record_end(text, cursor);
        end = end.max(record_end);
        cursor = record_end;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::{consumed_record_end, embedded_record_end};

    #[test]
    fn a_container_ends_after_its_matching_closer() {
        let text = r#"a {"note":{"deep":1}} tail"#;
        let start = 2;
        let end = embedded_record_end(text, start);
        assert_eq!(&text[start..end], r#"{"note":{"deep":1}}"#);
    }

    #[test]
    fn a_string_ends_after_its_unescaped_closing_quote() {
        let text = r#"say "a \"quoted\" value" now"#;
        let start = 4;
        let end = embedded_record_end(text, start);
        assert_eq!(&text[start..end], r#""a \"quoted\" value""#);
    }

    #[test]
    fn an_unclosed_record_runs_to_the_text_end() {
        let text = r#"before {"note":"unclosed"#;
        assert_eq!(embedded_record_end(text, 7), text.len());
    }

    #[test]
    fn a_deeper_stack_than_the_budget_returns_the_whole_text() {
        let text = format!("{}1{}", "[".repeat(40), "]".repeat(40));
        assert_eq!(embedded_record_end(&text, 0), text.len());
    }

    #[test]
    fn consuming_an_opener_consumes_its_enclosing_record() {
        let text = r#"lead{"credentials":{"login":"secret"},"code":7} after"#;
        assert_eq!(
            consumed_record_end(text, 4, 5),
            text.find(" after").expect("the tail exists")
        );
    }
}
