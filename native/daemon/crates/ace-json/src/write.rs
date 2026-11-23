// SPDX-License-Identifier: Apache-2.0
//! `JSON.stringify`, byte for byte, without recursion. Strings escape exactly what
//! `QuoteJSONString` escapes: `"` `\` and the controls (`\b \t \n \f \r`, else `\u00xx` in
//! lowercase), lone surrogates as `\udxxx`; everything else, U+2028 and `/` included, is
//! written as is. Numbers follow [`crate::number::write_number`].

use crate::number::write_number;
use crate::object::Map;
use crate::raw::{Raw, RawRef};
use crate::string::{JsString, is_high, is_low};
use crate::value::Value;

const HEX: &[u8; 16] = b"0123456789abcdef";

fn push_unit_escape(out: &mut String, unit: u16) {
    out.push_str("\\u");
    for shift in [12, 8, 4, 0] {
        let digit = HEX
            .get(usize::from((unit >> shift) & 0xf))
            .copied()
            .unwrap_or(b'0');
        out.push(char::from(digit));
    }
}

/// The escape for an ASCII byte, if `JSON.stringify` escapes it.
fn escape(byte: u8) -> Option<&'static str> {
    Some(match byte {
        b'"' => "\\\"",
        b'\\' => "\\\\",
        0x08 => "\\b",
        b'\t' => "\\t",
        b'\n' => "\\n",
        0x0c => "\\f",
        b'\r' => "\\r",
        0x00..=0x1f => "",
        _ => return None,
    })
}

/// `JSON.stringify(text)` for a well-formed string.
pub fn write_str(out: &mut String, text: &str) {
    out.reserve(text.len() + 2);
    out.push('"');
    let mut start = 0;
    for (at, byte) in text.bytes().enumerate() {
        let Some(escaped) = escape(byte) else {
            continue;
        };
        out.push_str(text.get(start..at).unwrap_or(""));
        if escaped.is_empty() {
            push_unit_escape(out, u16::from(byte));
        } else {
            out.push_str(escaped);
        }
        start = at + 1;
    }
    out.push_str(text.get(start..).unwrap_or(""));
    out.push('"');
}

/// `JSON.stringify(text)` for any JavaScript string.
pub fn write_js_string(out: &mut String, text: &JsString) {
    match text.repr_units() {
        None => write_str(out, text.as_str().unwrap_or("")),
        Some(units) => write_units(out, units),
    }
}

fn write_units(out: &mut String, units: &[u16]) {
    out.push('"');
    let mut at = 0;
    while let Some(&unit) = units.get(at) {
        at += 1;
        if unit < 0x80 {
            let byte = unit as u8;
            match escape(byte) {
                Some("") => push_unit_escape(out, unit),
                Some(escaped) => out.push_str(escaped),
                None => out.push(char::from(byte)),
            }
        } else if is_high(unit)
            && let Some(&low) = units.get(at)
            && is_low(low)
        {
            at += 1;
            let code = 0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
            out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
        } else if is_high(unit) || is_low(unit) {
            push_unit_escape(out, unit);
        } else {
            out.push(char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER));
        }
    }
    out.push('"');
}

/// One container being written: its remaining children and whether one was written yet.
enum Frame<'a> {
    Items(std::slice::Iter<'a, Value>, bool),
    Entries(indexmap::map::Iter<'a, JsString, Value>, bool),
}

/// Write a leaf, or open a container and push its frame.
fn open<'a>(out: &mut String, value: &'a Value, stack: &mut Vec<Frame<'a>>) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(out, number.value()),
        Value::String(text) => write_js_string(out, text),
        Value::Array(items) => {
            out.push('[');
            stack.push(Frame::Items(items.iter(), false));
        }
        Value::Object(map) => {
            out.push('{');
            stack.push(Frame::Entries(map.iter(), false));
        }
    }
}

fn run(out: &mut String, mut stack: Vec<Frame<'_>>) {
    loop {
        let next = match stack.last_mut() {
            None => return,
            Some(Frame::Items(iter, wrote)) => match iter.next() {
                Some(child) => {
                    if std::mem::replace(wrote, true) {
                        out.push(',');
                    }
                    Some(child)
                }
                None => {
                    out.push(']');
                    None
                }
            },
            Some(Frame::Entries(iter, wrote)) => match iter.next() {
                Some((key, child)) => {
                    if std::mem::replace(wrote, true) {
                        out.push(',');
                    }
                    write_js_string(out, key);
                    out.push(':');
                    Some(child)
                }
                None => {
                    out.push('}');
                    None
                }
            },
        };
        match next {
            Some(child) => open(out, child, &mut stack),
            None => {
                stack.pop();
            }
        }
    }
}

/// Append `JSON.stringify(value)`.
pub fn write_value(out: &mut String, value: &Value) {
    let mut stack = Vec::new();
    open(out, value, &mut stack);
    run(out, stack);
}

pub(crate) fn write_map(out: &mut String, map: &Map) {
    out.push('{');
    run(out, vec![Frame::Entries(map.iter(), false)]);
}

pub(crate) fn write_items(out: &mut String, items: &[Value]) {
    out.push('[');
    run(out, vec![Frame::Items(items.iter(), false)]);
}

/// `JSON.stringify(value)`.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// Builds one JSON object by appending fields, splicing already-serialized values verbatim:
/// what a translator uses to emit a fact without building its tree.
pub struct ObjectWriter<'o> {
    out: &'o mut String,
    wrote: bool,
}

impl<'o> ObjectWriter<'o> {
    pub fn new(out: &'o mut String) -> ObjectWriter<'o> {
        out.push('{');
        ObjectWriter { out, wrote: false }
    }

    fn key(&mut self, key: &str) -> &mut String {
        if std::mem::replace(&mut self.wrote, true) {
            self.out.push(',');
        }
        write_str(self.out, key);
        self.out.push(':');
        self.out
    }

    pub fn value(&mut self, key: &str, value: &Value) -> &mut Self {
        write_value(self.key(key), value);
        self
    }

    pub fn str(&mut self, key: &str, text: &str) -> &mut Self {
        write_str(self.key(key), text);
        self
    }

    pub fn number(&mut self, key: &str, number: f64) -> &mut Self {
        write_number(self.key(key), number);
        self
    }

    pub fn bool(&mut self, key: &str, flag: bool) -> &mut Self {
        self.key(key).push_str(if flag { "true" } else { "false" });
        self
    }

    /// Splice an owned serialized value as is.
    pub fn raw(&mut self, key: &str, raw: &Raw) -> &mut Self {
        self.key(key).push_str(raw.get());
        self
    }

    /// Splice a borrowed sub-value: verbatim when its document is canonical, else re-encoded.
    pub fn raw_ref(&mut self, key: &str, raw: RawRef<'_>) -> &mut Self {
        raw.write_to(self.key(key));
        self
    }

    /// Splice every field of a serialized object (the members between its braces).
    pub fn spread_raw(&mut self, object: &Raw) -> &mut Self {
        let text = object.get().trim();
        if let Some(inner) = text
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
            && !inner.is_empty()
        {
            if std::mem::replace(&mut self.wrote, true) {
                self.out.push(',');
            }
            self.out.push_str(inner);
        }
        self
    }

    pub fn finish(self) {
        self.out.push('}');
    }
}
