// SPDX-License-Identifier: Apache-2.0
//! `JSON.parse` without a reviver, without recursion and without a depth limit: the grammar of
//! ECMA-404 exactly (whitespace is space, tab, LF and CR only; no leading zeros, `+`, `.5`,
//! trailing commas, comments or raw control characters), `\u` escapes kept as code units so a
//! lone surrogate survives, numbers rounded to the nearest f64 (`1e400` is Infinity), and a
//! duplicate key replaces the earlier value in the earlier key's place.

use std::fmt;

use crate::number::Number;
use crate::object::Map;
use crate::string::{JsString, is_high, is_low};
use crate::value::{Array, Value};

/// What `JSON.parse` throws as a `SyntaxError`; bindings rethrow it as one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    /// Byte offset of the offending input.
    pub position: usize,
    pub reason: &'static str,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "JSON Parse error: {} at position {}",
            self.reason, self.position
        )
    }
}

impl std::error::Error for SyntaxError {}

pub(crate) struct Cursor<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) text: &'a str,
    pub(crate) pos: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(text: &'a str) -> Cursor<'a> {
        Cursor {
            bytes: text.as_bytes(),
            text,
            pos: 0,
        }
    }

    pub(crate) fn fail<T>(&self, reason: &'static str) -> Result<T, SyntaxError> {
        Err(SyntaxError {
            position: self.pos,
            reason,
        })
    }

    pub(crate) fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    pub(crate) fn skip_ws(&mut self) -> bool {
        let start = self.pos;
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.pos += 1;
        }
        self.pos != start
    }

    pub(crate) fn expect_word(&mut self, word: &[u8]) -> Result<(), SyntaxError> {
        if self.bytes.get(self.pos..self.pos + word.len()) == Some(word) {
            self.pos += word.len();
            Ok(())
        } else {
            self.fail("Unexpected token")
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while let Some(b'0'..=b'9') = self.peek() {
            self.pos += 1;
        }
        self.pos - start
    }

    /// Scan a number token; its text.
    pub(crate) fn number_text(&mut self) -> Result<&'a str, SyntaxError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.fail("Unexpected token"),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if self.digits() == 0 {
                return self.fail("Unterminated fractional number");
            }
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.pos += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return self.fail("Exponent part is missing a number");
            }
        }
        match self.text.get(start..self.pos) {
            Some(text) => Ok(text),
            None => self.fail("Unexpected token"),
        }
    }

    fn number(&mut self) -> Result<Value, SyntaxError> {
        let text = self.number_text()?;
        match text.parse::<f64>() {
            Ok(value) => Ok(Value::Number(Number::from_f64_lossy(value))),
            Err(_) => self.fail("Unexpected token"),
        }
    }

    pub(crate) fn hex4(&mut self) -> Result<u16, SyntaxError> {
        let mut unit = 0u16;
        for _ in 0..4 {
            let nibble = match self.peek() {
                Some(digit @ b'0'..=b'9') => digit - b'0',
                Some(digit @ b'a'..=b'f') => digit - b'a' + 10,
                Some(digit @ b'A'..=b'F') => digit - b'A' + 10,
                _ => return self.fail("Invalid escape character"),
            };
            self.pos += 1;
            unit = (unit << 4) | u16::from(nibble);
        }
        Ok(unit)
    }

    /// A string literal after its opening quote, decoded.
    pub(crate) fn string(&mut self) -> Result<JsString, SyntaxError> {
        let start = self.pos;
        // Fast path: no escapes, so the literal is its own text.
        while let Some(byte) = self.peek() {
            match byte {
                b'"' => {
                    let text = self.text.get(start..self.pos).unwrap_or("");
                    self.pos += 1;
                    return Ok(JsString::from(text));
                }
                b'\\' => break,
                0x00..=0x1f => return self.fail("Unterminated string"),
                _ => self.pos += 1,
            }
        }
        if self.peek().is_none() {
            return self.fail("Unterminated string");
        }
        let mut text = String::from(self.text.get(start..self.pos).unwrap_or(""));
        let mut units: Option<Vec<u16>> = None;
        loop {
            let run = self.pos;
            while let Some(byte) = self.peek()
                && byte != b'"'
                && byte != b'\\'
                && byte >= 0x20
            {
                self.pos += 1;
            }
            let plain = self.text.get(run..self.pos).unwrap_or("");
            match &mut units {
                Some(units) => units.extend(plain.encode_utf16()),
                None => text.push_str(plain),
            }
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(match units {
                        Some(units) => JsString::from_units(&units),
                        None => JsString::from(text),
                    });
                }
                Some(b'\\') => self.pos += 1,
                _ => return self.fail("Unterminated string"),
            }
            let simple = match self.peek() {
                Some(b'"') => '"',
                Some(b'\\') => '\\',
                Some(b'/') => '/',
                Some(b'b') => '\u{8}',
                Some(b'f') => '\u{c}',
                Some(b'n') => '\n',
                Some(b'r') => '\r',
                Some(b't') => '\t',
                Some(b'u') => {
                    self.pos += 1;
                    let unit = self.unicode_escape()?;
                    push_unit(&mut text, &mut units, unit);
                    continue;
                }
                _ => return self.fail("Invalid escape character"),
            };
            self.pos += 1;
            match &mut units {
                Some(units) => units.push(simple as u16),
                None => text.push(simple),
            }
        }
    }

    /// One `\uXXXX` (after `\u`), joined with a following `\uXXXX` low surrogate when it is a
    /// high one, exactly as the code units would join in a JavaScript string.
    fn unicode_escape(&mut self) -> Result<Escaped, SyntaxError> {
        let unit = self.hex4()?;
        if is_high(unit) && self.bytes.get(self.pos..self.pos + 2) == Some(b"\\u") {
            let save = self.pos;
            self.pos += 2;
            let low = self.hex4()?;
            if is_low(low) {
                return Ok(Escaped::Pair(unit, low));
            }
            self.pos = save;
        }
        Ok(Escaped::Unit(unit))
    }
}

enum Escaped {
    Unit(u16),
    Pair(u16, u16),
}

fn push_unit(text: &mut String, units: &mut Option<Vec<u16>>, escaped: Escaped) {
    let (first, second) = match escaped {
        Escaped::Unit(unit) => (unit, None),
        Escaped::Pair(high, low) => (high, Some(low)),
    };
    if let Some(units) = units {
        units.push(first);
        units.extend(second);
        return;
    }
    let decoded = match second {
        Some(low) => char::decode_utf16([first, low]).next(),
        None => char::decode_utf16([first]).next(),
    };
    match decoded {
        Some(Ok(c)) => text.push(c),
        _ => {
            // A lone surrogate: from here the string keeps code units.
            let mut kept: Vec<u16> = text.encode_utf16().collect();
            kept.push(first);
            kept.extend(second);
            *units = Some(kept);
        }
    }
}

/// An open container while parsing.
enum Open {
    Array(Vec<Value>),
    Object(Map, Option<JsString>),
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value, SyntaxError> {
    let mut cursor = Cursor::new(text);
    let mut stack: Vec<Open> = Vec::new();
    loop {
        cursor.skip_ws();
        // A value (or, right after `[`, an immediate `]`).
        let mut done = match cursor.peek() {
            Some(b'{') => {
                cursor.pos += 1;
                cursor.skip_ws();
                if cursor.peek() == Some(b'}') {
                    cursor.pos += 1;
                    Value::Object(Map::new())
                } else {
                    let key = object_key(&mut cursor)?;
                    stack.push(Open::Object(Map::new(), Some(key)));
                    continue;
                }
            }
            Some(b'[') => {
                cursor.pos += 1;
                cursor.skip_ws();
                if cursor.peek() == Some(b']') {
                    cursor.pos += 1;
                    Value::Array(Array::new())
                } else {
                    stack.push(Open::Array(Vec::new()));
                    continue;
                }
            }
            Some(b'"') => {
                cursor.pos += 1;
                Value::String(cursor.string()?)
            }
            Some(b't') => cursor.expect_word(b"true").map(|()| Value::Bool(true))?,
            Some(b'f') => cursor.expect_word(b"false").map(|()| Value::Bool(false))?,
            Some(b'n') => cursor.expect_word(b"null").map(|()| Value::Null)?,
            Some(_) => cursor.number()?,
            None => return cursor.fail("Unexpected end of input"),
        };
        // Attach the finished value, closing every container it completes.
        loop {
            match stack.last_mut() {
                None => {
                    cursor.skip_ws();
                    return match cursor.peek() {
                        None => Ok(done),
                        Some(_) => cursor.fail("Unexpected non-whitespace character after JSON"),
                    };
                }
                Some(Open::Array(items)) => {
                    items.push(done);
                    cursor.skip_ws();
                    match cursor.peek() {
                        Some(b',') => {
                            cursor.pos += 1;
                            break;
                        }
                        Some(b']') => {
                            cursor.pos += 1;
                            done = match stack.pop() {
                                Some(Open::Array(items)) => Value::Array(Array::from(items)),
                                _ => return cursor.fail("Unexpected token"),
                            };
                        }
                        _ => return cursor.fail("Expected ',' or ']' after array element"),
                    }
                }
                Some(Open::Object(map, key)) => {
                    if let Some(key) = key.take() {
                        map.insert(key, done);
                    }
                    cursor.skip_ws();
                    match cursor.peek() {
                        Some(b',') => {
                            cursor.pos += 1;
                            cursor.skip_ws();
                            let next = object_key(&mut cursor)?;
                            if let Some(Open::Object(_, key)) = stack.last_mut() {
                                *key = Some(next);
                            }
                            break;
                        }
                        Some(b'}') => {
                            cursor.pos += 1;
                            done = match stack.pop() {
                                Some(Open::Object(map, _)) => Value::Object(map),
                                _ => return cursor.fail("Unexpected token"),
                            };
                        }
                        _ => return cursor.fail("Expected ',' or '}' after property value"),
                    }
                }
            }
        }
    }
}

/// A member's key and its colon.
fn object_key(cursor: &mut Cursor<'_>) -> Result<JsString, SyntaxError> {
    if cursor.peek() != Some(b'"') {
        return cursor.fail("Expected property name");
    }
    cursor.pos += 1;
    let key = cursor.string()?;
    cursor.skip_ws();
    if cursor.peek() != Some(b':') {
        return cursor.fail("Expected ':' after property name");
    }
    cursor.pos += 1;
    Ok(key)
}
