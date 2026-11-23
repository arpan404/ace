// SPDX-License-Identifier: Apache-2.0
//! Validation and skipping over JSON text, without building values or recursing. Validation
//! also answers whether the text is canonical: exactly what `JSON.stringify(JSON.parse(text))`
//! would write (no insignificant whitespace, numbers in `Number::toString` form, only the
//! escapes `JSON.stringify` writes, no duplicate keys, array-index keys first in ascending
//! order). Every sub-value of a canonical text is canonical too, so it can be spliced verbatim.

use std::collections::HashSet;

use crate::number::write_number;
use crate::parse::{Cursor, SyntaxError};
use crate::string::{is_high, is_low};

/// Above this many keys an object's duplicate check switches from a scan to a set.
const LINEAR_KEYS: usize = 16;

struct ObjectKeys<'a> {
    start: usize,
    set: Option<HashSet<&'a str>>,
    last_index: Option<u32>,
    named: bool,
}

struct Checker<'a> {
    cursor: Cursor<'a>,
    canonical: bool,
    keys: Vec<&'a str>,
}

/// Whether a key literal's text (escapes as written) names an array index.
fn literal_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes.len() > 1 && bytes.first() == Some(&b'0')) {
        return None;
    }
    let mut value: u64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(byte - b'0');
    }
    (value < u64::from(u32::MAX)).then_some(value as u32)
}

impl<'a> Checker<'a> {
    fn ws(&mut self) {
        if self.cursor.skip_ws() {
            self.canonical = false;
        }
    }

    fn number(&mut self) -> Result<(), SyntaxError> {
        let text = self.cursor.number_text()?;
        if !self.canonical {
            return Ok(());
        }
        let plain = text.bytes().all(|b| b.is_ascii_digit() || b == b'-');
        if plain && text.len() <= 15 && text != "-0" {
            return Ok(());
        }
        let mut written = String::new();
        write_number(&mut written, text.parse::<f64>().unwrap_or(f64::NAN));
        if written != text {
            self.canonical = false;
        }
        Ok(())
    }

    /// A string literal after its quote; the literal's inner text as written.
    fn string(&mut self) -> Result<&'a str, SyntaxError> {
        let start = self.cursor.pos;
        loop {
            match self.cursor.peek() {
                Some(b'"') => {
                    let inner = self.cursor.text.get(start..self.cursor.pos).unwrap_or("");
                    self.cursor.pos += 1;
                    return Ok(inner);
                }
                Some(b'\\') => {
                    self.cursor.pos += 1;
                    self.escape()?;
                }
                Some(0x00..=0x1f) | None => return self.cursor.fail("Unterminated string"),
                Some(_) => self.cursor.pos += 1,
            }
        }
    }

    fn escape(&mut self) -> Result<(), SyntaxError> {
        match self.cursor.peek() {
            Some(b'"' | b'\\' | b'b' | b'f' | b'n' | b'r' | b't') => self.cursor.pos += 1,
            Some(b'/') => {
                self.cursor.pos += 1;
                self.canonical = false;
            }
            Some(b'u') => {
                self.cursor.pos += 1;
                let digits = self.cursor.pos;
                let unit = self.cursor.hex4()?;
                if self.canonical {
                    let lower = self
                        .cursor
                        .bytes
                        .get(digits..digits + 4)
                        .is_some_and(|hex| !hex.iter().any(u8::is_ascii_uppercase));
                    let short = matches!(unit, 0x08 | 0x09 | 0x0a | 0x0c | 0x0d);
                    let written = (unit < 0x20 && !short) || self.lone(unit);
                    if !lower || !written {
                        self.canonical = false;
                    }
                }
            }
            _ => return self.cursor.fail("Invalid escape character"),
        }
        Ok(())
    }

    /// Whether the surrogate just read is unpaired in the text (so `JSON.stringify` escapes it).
    fn lone(&self, unit: u16) -> bool {
        let at = self.cursor.pos;
        if is_high(unit) {
            let next = self.cursor.bytes.get(at..at + 6);
            let low = next
                .filter(|next| next.starts_with(b"\\u"))
                .and_then(|next| std::str::from_utf8(next.get(2..)?).ok())
                .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                .is_some_and(is_low);
            !low
        } else if is_low(unit) {
            // A low surrogate right after an escaped high one would have paired with it; that
            // pair is already non-canonical, checked when the high one was read.
            true
        } else {
            false
        }
    }

    fn key(&mut self, object: &mut ObjectKeys<'a>) -> Result<(), SyntaxError> {
        if self.cursor.peek() != Some(b'"') {
            return self.cursor.fail("Expected property name");
        }
        self.cursor.pos += 1;
        let key = self.string()?;
        self.ws();
        if self.cursor.peek() != Some(b':') {
            return self.cursor.fail("Expected ':' after property name");
        }
        self.cursor.pos += 1;
        if self.canonical {
            self.check_key(object, key);
        }
        Ok(())
    }

    fn check_key(&mut self, object: &mut ObjectKeys<'a>, key: &'a str) {
        match literal_index(key) {
            Some(index) => {
                if object.named || object.last_index.is_some_and(|last| last >= index) {
                    self.canonical = false;
                }
                object.last_index = Some(index);
            }
            None => object.named = true,
        }
        let seen = self.keys.get(object.start..).unwrap_or(&[]);
        let duplicate = match &mut object.set {
            Some(set) => !set.insert(key),
            None if seen.len() < LINEAR_KEYS => seen.contains(&key),
            None => {
                let mut set: HashSet<&'a str> = seen.iter().copied().collect();
                let duplicate = !set.insert(key);
                object.set = Some(set);
                duplicate
            }
        };
        if duplicate {
            self.canonical = false;
        }
        if object.set.is_none() {
            self.keys.push(key);
        }
    }
}

/// Validate `text` as one JSON value; whether it is canonical.
pub(crate) fn validate(text: &str) -> Result<bool, SyntaxError> {
    let mut checker = Checker {
        cursor: Cursor::new(text),
        canonical: true,
        keys: Vec::new(),
    };
    // `None` is an open array; `Some` an open object.
    let mut stack: Vec<Option<ObjectKeys<'_>>> = Vec::new();
    loop {
        checker.ws();
        match checker.cursor.peek() {
            Some(b'{') => {
                checker.cursor.pos += 1;
                checker.ws();
                if checker.cursor.peek() == Some(b'}') {
                    checker.cursor.pos += 1;
                } else {
                    let mut object = ObjectKeys {
                        start: checker.keys.len(),
                        set: None,
                        last_index: None,
                        named: false,
                    };
                    checker.key(&mut object)?;
                    stack.push(Some(object));
                    continue;
                }
            }
            Some(b'[') => {
                checker.cursor.pos += 1;
                checker.ws();
                if checker.cursor.peek() == Some(b']') {
                    checker.cursor.pos += 1;
                } else {
                    stack.push(None);
                    continue;
                }
            }
            Some(b'"') => {
                checker.cursor.pos += 1;
                checker.string()?;
            }
            Some(b't') => checker.cursor.expect_word(b"true")?,
            Some(b'f') => checker.cursor.expect_word(b"false")?,
            Some(b'n') => checker.cursor.expect_word(b"null")?,
            Some(_) => checker.number()?,
            None => return checker.cursor.fail("Unexpected end of input"),
        }
        // Close what the value completes.
        loop {
            checker.ws();
            let Some(top) = stack.last_mut() else {
                return match checker.cursor.peek() {
                    None => Ok(checker.canonical),
                    Some(_) => checker
                        .cursor
                        .fail("Unexpected non-whitespace character after JSON"),
                };
            };
            match (checker.cursor.peek(), top) {
                (Some(b','), None) => {
                    checker.cursor.pos += 1;
                    break;
                }
                (Some(b','), Some(object)) => {
                    checker.cursor.pos += 1;
                    checker.ws();
                    checker.key(object)?;
                    break;
                }
                (Some(b']'), None) | (Some(b'}'), Some(_)) => {
                    checker.cursor.pos += 1;
                    if let Some(Some(object)) = stack.pop() {
                        checker.keys.truncate(object.start);
                    }
                }
                (_, None) => {
                    return checker
                        .cursor
                        .fail("Expected ',' or ']' after array element");
                }
                (_, Some(_)) => {
                    return checker
                        .cursor
                        .fail("Expected ',' or '}' after property value");
                }
            }
        }
    }
}

/// The end of the value starting at `at` in validated text.
pub(crate) fn skip_value(bytes: &[u8], at: usize) -> usize {
    match bytes.get(at) {
        Some(b'"') => skip_string(bytes, at + 1),
        Some(b'[' | b'{') => {
            let (mut at, mut depth) = (at, 0usize);
            loop {
                match bytes.get(at) {
                    None => return at,
                    Some(b'"') => {
                        at = skip_string(bytes, at + 1);
                        continue;
                    }
                    Some(b'[' | b'{') => depth += 1,
                    Some(b']' | b'}') => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            return at + 1;
                        }
                    }
                    Some(_) => {}
                }
                at += 1;
            }
        }
        _ => {
            let mut at = at;
            while let Some(byte) = bytes.get(at)
                && !matches!(
                    byte,
                    b',' | b']' | b'}' | b':' | b' ' | b'\t' | b'\n' | b'\r'
                )
            {
                at += 1;
            }
            at
        }
    }
}

/// Past the closing quote of a string whose opening quote ends before `at`.
pub(crate) fn skip_string(bytes: &[u8], mut at: usize) -> usize {
    loop {
        match bytes.get(at) {
            None => return at,
            Some(b'"') => return at + 1,
            Some(b'\\') => at += 2,
            Some(_) => at += 1,
        }
    }
}

pub(crate) fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while let Some(b' ' | b'\t' | b'\n' | b'\r') = bytes.get(at) {
        at += 1;
    }
    at
}
