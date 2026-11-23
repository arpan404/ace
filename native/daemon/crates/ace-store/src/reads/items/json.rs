// SPDX-License-Identifier: Apache-2.0
use super::Result;
use super::parse::parse_error;

/// JSON with strings as UTF-16 units, exactly as JavaScript holds them: two lone surrogates
/// join into the pair, and a lone one serialises as `\uXXXX`, like `JSON.stringify`. Numbers
/// keep their stored text, so trusted output is byte-identical without re-encoding.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum J {
    Null,
    Bool(bool),
    Num(String),
    Str(Vec<u16>),
    Arr(Vec<J>),
    Obj(Vec<(Vec<u16>, J)>),
}

pub(crate) fn encode_units(text: &str) -> Vec<u16> {
    let mut units = Vec::with_capacity(text.len());
    let mut pair = [0u16; 2];
    for c in text.chars() {
        units.extend_from_slice(c.encode_utf16(&mut pair));
    }
    units
}

pub(crate) fn units_eq(left: &[u16], right: &str) -> bool {
    // Every key this reader looks up is ASCII; anything else cannot match.
    left.len() == right.len()
        && left
            .iter()
            .zip(right.as_bytes())
            .all(|(unit, byte)| *unit == u16::from(*byte))
}

pub(crate) fn is_high(unit: u16) -> bool {
    (0xd800..0xdc00).contains(&unit)
}

pub(crate) fn is_low(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

/// `JSON.stringify` of a string, in UTF-8 bytes: short escapes, lowercase `\u00XX`, raw text
/// above, surrogate pairs as UTF-8, lone surrogates as `\uXXXX`.
pub(crate) fn push_string(out: &mut String, units: &[u16]) {
    out.push('"');
    push_string_inner(out, units);
    out.push('"');
}

/// The literal's inner text, without its quotes: stored JSON back to the text it was made from.
pub(crate) fn push_string_inner(out: &mut String, units: &[u16]) {
    let mut index = 0;
    while let Some(unit) = units.get(index) {
        let unit = *unit;
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0a => out.push_str("\\n"),
            0x0c => out.push_str("\\f"),
            0x0d => out.push_str("\\r"),
            0x00..=0x1f => {
                out.push_str(&format!("\\u{unit:04x}"));
            }
            _ if is_high(unit)
                && let Some(next) = units.get(index + 1)
                && is_low(*next) =>
            {
                let high = u32::from(unit - 0xd800);
                let low = u32::from(*next - 0xdc00);
                if let Some(c) = char::from_u32(0x10000 + high * 0x400 + low) {
                    out.push(c);
                } else {
                    out.push_str(&format!("\\u{unit:04x}"));
                    index += 1;
                    continue;
                }
                index += 1;
            }
            _ if is_high(unit) || is_low(unit) => {
                out.push_str(&format!("\\u{unit:04x}"));
            }
            _ => {
                if let Some(c) = char::from_u32(u32::from(unit)) {
                    out.push(c);
                } else {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
        index += 1;
    }
}

/// The bytes `push_string` would emit, without emitting them.
pub(crate) fn string_len(units: &[u16]) -> usize {
    let mut len = 2;
    let mut index = 0;
    while let Some(unit) = units.get(index) {
        let unit = *unit;
        match unit {
            0x22 | 0x5c => len += 2,
            0x08 | 0x09 | 0x0a | 0x0c | 0x0d => len += 2,
            0x00..=0x1f => len += 6,
            _ if is_high(unit)
                && let Some(next) = units.get(index + 1)
                && is_low(*next) =>
            {
                len += 4;
                index += 1;
            }
            _ if is_high(unit) || is_low(unit) => len += 6,
            0x20..=0x7f => len += 1,
            0x80..=0x7ff => len += 2,
            _ => len += 3,
        }
        index += 1;
    }
    len
}

pub(crate) fn write_json(out: &mut String, value: &J) {
    match value {
        J::Null => out.push_str("null"),
        J::Bool(true) => out.push_str("true"),
        J::Bool(false) => out.push_str("false"),
        J::Num(raw) => out.push_str(raw),
        J::Str(units) => push_string(out, units),
        J::Arr(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        J::Obj(entries) => {
            out.push('{');
            for (index, (key, value)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_string(out, key);
                out.push(':');
                write_json(out, value);
            }
            out.push('}');
        }
    }
}

pub(crate) fn json_bytes(value: &J) -> usize {
    let mut out = String::new();
    write_json(&mut out, value);
    out.len()
}

impl J {
    pub(crate) fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(entries) => entries
                .iter()
                .rev()
                .find(|(name, _)| units_eq(name, key))
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut J> {
        match self {
            J::Obj(entries) => entries
                .iter_mut()
                .rev()
                .find(|(name, _)| units_eq(name, key))
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// Set an existing key in place, else append it, like a JavaScript assignment.
    pub(crate) fn set(&mut self, key: &str, value: J) {
        if let J::Obj(entries) = self {
            if let Some(slot) = entries
                .iter_mut()
                .rev()
                .find(|(name, _)| units_eq(name, key))
            {
                slot.1 = value;
            } else {
                entries.push((encode_units(key), value));
            }
        }
    }

    pub(crate) fn remove(&mut self, key: &str) {
        if let J::Obj(entries) = self
            && let Some(index) = entries.iter().rposition(|(name, _)| units_eq(name, key))
        {
            entries.remove(index);
        }
    }

    pub(crate) fn as_int(&self) -> Result<i64> {
        match self {
            J::Num(raw) => raw.parse::<i64>().map_err(|_| parse_error()),
            _ => Err(parse_error()),
        }
    }
}

/// JavaScript truthiness, for fields the reader tests without validating: only `false`,
/// `0`, `""`, `null` and `undefined` (absent) are falsy; everything else, including empty
/// containers, is truthy.
pub(crate) fn js_truthy(value: &J) -> bool {
    match value {
        J::Null => false,
        J::Bool(done) => *done,
        J::Num(raw) => match raw.parse::<f64>() {
            Ok(n) => n != 0.0,
            Err(_) => true,
        },
        J::Str(units) => !units.is_empty(),
        J::Arr(_) | J::Obj(_) => true,
    }
}
/// The UTF-8 text of UTF-16 units, pairing surrogates and replacing lone ones, for display
/// uses like clipped titles where the count, not the encoding, must match.
pub(crate) fn lossy(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|next| next.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}
