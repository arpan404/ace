// SPDX-License-Identifier: Apache-2.0
//! Which request or thread a dropped output line belonged to
//! (`attributeDroppedLine`, `dropped-line.ts:8`). The line's bounded prefix is
//! scanned for complete tokens only: a value inside an unfinished string never
//! attributes anything, because it is not what the provider sent.

use ace_json::{JsString, Value};
use ace_supervisor::jsonrpc::RpcId;

/// What a dropped line's prefix says about it (`LineAttribution`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineAttribution {
    /// The envelope's own `id`, when a complete scalar carried it.
    pub id: Option<RpcId>,
    /// `params.threadId`, when one complete string carried it.
    pub thread_id: Option<JsString>,
    /// The line was a reply: a `result` or `error` member, and no `method`.
    pub response: bool,
}

/// One complete token of the prefix.
struct Token<'a> {
    text: &'a str,
    end: usize,
}

/// Scans the prefix in the order the TypeScript's sticky regular expression
/// does (`:9`): whitespace, then one string, punctuation, number, `true`,
/// `false` or `null`. Anything else, including an unfinished string, ends the
/// scan.
fn next_token(prefix: &str, offset: usize) -> Option<Token<'_>> {
    let mut at = offset;
    while let Some((_, ch)) = prefix[at..].char_indices().next() {
        if !is_js_space(ch) {
            break;
        }
        at += ch.len_utf8();
    }
    let rest = &prefix[at..];
    let first = rest.chars().next()?;
    let end = match first {
        '"' => scan_string(rest)?,
        '{' | '}' | '[' | ']' | ':' | ',' => 1,
        '-' | '0'..='9' => scan_number(rest),
        't' => literal(rest, "true")?,
        'f' => literal(rest, "false")?,
        'n' => literal(rest, "null")?,
        _ => return None,
    };
    Some(Token {
        text: &rest[..end],
        end: at + end,
    })
}

/// `"(?:\\.|[^"\\])*"`, where `.` does not match a line terminator.
fn scan_string(rest: &str) -> Option<usize> {
    let mut at = 1;
    while at < rest.len() {
        let ch = rest[at..].chars().next()?;
        match ch {
            '"' => return Some(at + 1),
            '\\' => {
                let escaped = rest[at + 1..].chars().next()?;
                if is_line_terminator(escaped) {
                    return None;
                }
                at += 1 + escaped.len_utf8();
            }
            _ => at += ch.len_utf8(),
        }
    }
    None
}

/// `-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`.
fn scan_number(rest: &str) -> usize {
    let bytes = rest.as_bytes();
    let digit = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_digit);
    let mut at = 0;
    if bytes.first() == Some(&b'-') {
        at += 1;
    }
    let digits = at;
    while digit(at) {
        at += 1;
    }
    if at == digits {
        return at;
    }
    if bytes.get(at) == Some(&b'.') && digit(at + 1) {
        at += 2;
        while digit(at) {
            at += 1;
        }
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let mut exponent = at + 1;
        if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        if digit(exponent) {
            at = exponent;
            while digit(at) {
                at += 1;
            }
        }
    }
    at
}

fn literal(rest: &str, word: &str) -> Option<usize> {
    rest.starts_with(word).then_some(word.len())
}

/// JavaScript's `\s`.
fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// A scalar token must end at a delimiter (or a space) before the next token
/// counts: `42e` is an unfinished number, not `42` and a stray `e` (`:24`).
fn ended(prefix: &str, offset: usize) -> bool {
    match prefix[offset..].chars().next() {
        None => false,
        Some(ch) => is_js_space(ch) || matches!(ch, ',' | '}' | ']'),
    }
}

/// The attribution one dropped line's prefix supports.
pub fn attribute_dropped_line(prefix: &str) -> LineAttribution {
    let mut result = LineAttribution::default();
    // `path` holds one entry per open container: the member key, or "" for an
    // array element and the document itself.
    let mut path: Vec<String> = Vec::new();
    let mut key = String::new();
    let mut previous = String::new();
    let mut last_string = String::new();
    let mut method = false;
    let mut offset = 0;
    while let Some(token) = next_token(prefix, offset) {
        offset = token.end;
        let value = token.text;
        let scalar = value
            .chars()
            .next()
            .is_some_and(|ch| ch == '-' || ch.is_ascii_digit() || matches!(ch, 't' | 'f' | 'n'));
        if scalar && !ended(prefix, offset) {
            break;
        }
        match value {
            ":" => {
                key.clone_from(&last_string);
                if path.len() == 1 && is_reply_member(&key) {
                    result.response = true;
                }
            }
            "{" | "[" => {
                if path.len() == 1 && previous == ":" && is_reply_member(&key) {
                    result.response = true;
                }
                path.push(if previous == ":" {
                    key.clone()
                } else {
                    String::new()
                });
            }
            "}" | "]" => {
                path.pop();
            }
            "," => {}
            _ => {
                let decoded = match ace_json::parse(value) {
                    Ok(decoded) => decoded,
                    Err(_) => break,
                };
                if !is_scalar(&decoded) {
                    break;
                }
                if previous == ":" {
                    if path.len() == 1 {
                        match key.as_str() {
                            "id" => result.id = rpc_id(&decoded),
                            "method" => method = true,
                            _ if is_reply_member(&key) => result.response = true,
                            _ => {}
                        }
                    }
                    if path.len() == 2
                        && path[1] == "params"
                        && key == "threadId"
                        && let Some(text) = decoded.as_js_str()
                    {
                        result.thread_id = Some(text.clone());
                    }
                }
                last_string = match &decoded {
                    Value::String(text) => text.as_str().to_owned(),
                    _ => String::new(),
                };
            }
        }
        previous = value.to_owned();
    }
    result.response = result.response && !method;
    result
}

fn is_reply_member(key: &str) -> bool {
    key == "result" || key == "error"
}

fn rpc_id(value: &Value) -> Option<RpcId> {
    match value {
        Value::String(text) => Some(RpcId::Text(text.clone())),
        // `z.number().finite()`: a number token JavaScript parses to an infinity is no id.
        Value::Number(number) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .map(RpcId::Number),
        _ => None,
    }
}

/// `z.number().finite()`, `z.string()`, `z.boolean()`, `z.null()`.
fn is_scalar(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Array(_) | Value::Object(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attributed(cases: &[(&str, LineAttribution)]) {
        for (prefix, expected) in cases {
            assert_eq!(&attribute_dropped_line(prefix), expected, "{prefix}");
        }
    }

    // Moved from `dropped-line.test.ts` (behaviour.md section 19).
    #[test]
    fn only_complete_envelope_fields_can_attribute_a_dropped_line() {
        attributed(&[
            (
                "{\"id\":42,\"result\":\"unfinished",
                LineAttribution {
                    id: Some(RpcId::Number(42.0)),
                    thread_id: None,
                    response: true,
                },
            ),
            (
                "{\"id\":42,\"result\":{\"text\":\"unfinished",
                LineAttribution {
                    id: Some(RpcId::Number(42.0)),
                    thread_id: None,
                    response: true,
                },
            ),
            (
                "{\"result\":{\"id\":123,\"text\":\"unfinished",
                LineAttribution {
                    id: None,
                    thread_id: None,
                    response: true,
                },
            ),
            (
                "{\"id\":\"request\\\"42\",\"error\":{\"message\":\"unfinished",
                LineAttribution {
                    id: Some(RpcId::Text(JsString::from("request\"42"))),
                    thread_id: None,
                    response: true,
                },
            ),
            (
                "{\"method\":\"item/completed\",\"params\":{\"threadId\":\"a\",\"item\":{\"id\":42,\"text\":\"unfinished",
                LineAttribution {
                    id: None,
                    thread_id: Some(JsString::from("a")),
                    response: false,
                },
            ),
            (
                "{\"padding\":\"fake \\\"id\\\":42",
                LineAttribution::default(),
            ),
            (
                "{\"result\":{},\"id\":42",
                LineAttribution {
                    id: None,
                    thread_id: None,
                    response: true,
                },
            ),
            (
                "{\"result\":{},\"id\":42e",
                LineAttribution {
                    id: None,
                    thread_id: None,
                    response: true,
                },
            ),
            ("{\"id\":\"invalid\\x\"", LineAttribution::default()),
        ]);
    }
}
