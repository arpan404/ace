// SPDX-License-Identifier: Apache-2.0
//! Strings as JavaScript holds them: a sequence of UTF-16 code units, where a lone surrogate
//! (`"\ud800"`) is an ordinary string. Nearly every string is well-formed, so those stay a Rust
//! `String` (cheap `&str` reads, byte-wise lookups); only a string holding a lone surrogate keeps
//! its code units. The two forms never describe the same string, so equality and hashing can
//! compare them form by form.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt;
use std::hash::{Hash, Hasher};

/// A JavaScript string. See the module docs for the two forms.
#[derive(Clone, Default)]
pub struct JsString(Repr);

#[derive(Clone)]
enum Repr {
    Utf8(String),
    /// Holds at least one lone surrogate; never a well-formed string.
    Units(Box<[u16]>),
}

impl Default for Repr {
    fn default() -> Repr {
        Repr::Utf8(String::new())
    }
}

pub(crate) fn is_high(unit: u16) -> bool {
    (0xd800..0xdc00).contains(&unit)
}

pub(crate) fn is_low(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

impl JsString {
    pub const fn new() -> JsString {
        JsString(Repr::Utf8(String::new()))
    }

    /// The string of these UTF-16 code units, pairing surrogates as JavaScript does.
    pub fn from_units(units: &[u16]) -> JsString {
        let mut text = String::with_capacity(units.len());
        for decoded in char::decode_utf16(units.iter().copied()) {
            match decoded {
                Ok(c) => text.push(c),
                Err(_) => return JsString(Repr::Units(units.into())),
            }
        }
        JsString(Repr::Utf8(text))
    }

    /// The text when the string is well-formed; `None` when it holds a lone surrogate.
    pub fn as_str(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8(text) => Some(text),
            Repr::Units(_) => None,
        }
    }

    /// The text, with each lone surrogate replaced by U+FFFD.
    pub fn to_string_lossy(&self) -> Cow<'_, str> {
        match &self.0 {
            Repr::Utf8(text) => Cow::Borrowed(text),
            Repr::Units(units) => Cow::Owned(
                char::decode_utf16(units.iter().copied())
                    .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
                    .collect(),
            ),
        }
    }

    /// The text, owned, when well-formed.
    pub fn into_string(self) -> Result<String, JsString> {
        match self.0 {
            Repr::Utf8(text) => Ok(text),
            units => Err(JsString(units)),
        }
    }

    /// The string's UTF-16 code units, as JavaScript indexes them.
    pub fn units(&self) -> Units<'_> {
        match &self.0 {
            Repr::Utf8(text) => Units::Utf8(text.encode_utf16()),
            Repr::Units(units) => Units::Slice(units.iter()),
        }
    }

    /// `string.length`: the count of UTF-16 code units.
    pub fn len_utf16(&self) -> usize {
        match &self.0 {
            Repr::Utf8(text) => text.encode_utf16().count(),
            Repr::Units(units) => units.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Repr::Utf8(text) => text.is_empty(),
            Repr::Units(units) => units.is_empty(),
        }
    }

    /// Whether this is a well-formed string (no lone surrogate).
    pub fn is_well_formed(&self) -> bool {
        matches!(self.0, Repr::Utf8(_))
    }

    /// `a + b` for strings: a trailing high surrogate and a leading low one join into a pair.
    pub fn push_js(&mut self, other: &JsString) {
        match (&mut self.0, &other.0) {
            (Repr::Utf8(text), Repr::Utf8(more)) => text.push_str(more),
            _ => {
                let mut units: Vec<u16> = self.units().collect();
                units.extend(other.units());
                *self = JsString::from_units(&units);
            }
        }
    }

    pub fn push_str(&mut self, more: &str) {
        match &mut self.0 {
            Repr::Utf8(text) => text.push_str(more),
            Repr::Units(_) => self.push_js(&JsString::from(more)),
        }
    }

    /// `string.slice(start, end)` over UTF-16 code units, clamped like JavaScript's.
    pub fn slice_units(&self, start: usize, end: usize) -> JsString {
        let units: Vec<u16> = self.units().collect();
        let end = end.min(units.len());
        let start = start.min(end);
        units
            .get(start..end)
            .map(JsString::from_units)
            .unwrap_or_default()
    }

    pub(crate) fn repr_units(&self) -> Option<&[u16]> {
        match &self.0 {
            Repr::Utf8(_) => None,
            Repr::Units(units) => Some(units),
        }
    }
}

/// The UTF-16 code units of a [`JsString`].
pub enum Units<'a> {
    Utf8(std::str::EncodeUtf16<'a>),
    Slice(std::slice::Iter<'a, u16>),
}

impl Iterator for Units<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        match self {
            Units::Utf8(iter) => iter.next(),
            Units::Slice(iter) => iter.next().copied(),
        }
    }
}

impl From<String> for JsString {
    fn from(text: String) -> JsString {
        JsString(Repr::Utf8(text))
    }
}

impl From<&str> for JsString {
    fn from(text: &str) -> JsString {
        JsString(Repr::Utf8(text.to_owned()))
    }
}

impl From<&String> for JsString {
    fn from(text: &String) -> JsString {
        JsString(Repr::Utf8(text.clone()))
    }
}

impl From<Cow<'_, str>> for JsString {
    fn from(text: Cow<'_, str>) -> JsString {
        JsString(Repr::Utf8(text.into_owned()))
    }
}

impl From<&JsString> for JsString {
    fn from(text: &JsString) -> JsString {
        text.clone()
    }
}

impl From<char> for JsString {
    fn from(c: char) -> JsString {
        JsString(Repr::Utf8(c.to_string()))
    }
}

impl PartialEq for JsString {
    fn eq(&self, other: &JsString) -> bool {
        match (&self.0, &other.0) {
            (Repr::Utf8(a), Repr::Utf8(b)) => a == b,
            (Repr::Units(a), Repr::Units(b)) => a == b,
            _ => false,
        }
    }
}

impl Eq for JsString {}

impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == Some(other)
    }
}

impl PartialEq<&str> for JsString {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == Some(*other)
    }
}

impl PartialEq<String> for JsString {
    fn eq(&self, other: &String) -> bool {
        self.as_str() == Some(other.as_str())
    }
}

impl PartialEq<JsString> for str {
    fn eq(&self, other: &JsString) -> bool {
        other == self
    }
}

impl PartialEq<JsString> for &str {
    fn eq(&self, other: &JsString) -> bool {
        other == *self
    }
}

impl PartialEq<JsString> for String {
    fn eq(&self, other: &JsString) -> bool {
        other == self
    }
}

/// Hashes a well-formed string's bytes the same way [`crate::object`] hashes a `&str` lookup.
pub(crate) fn hash_text<H: Hasher>(text: &str, state: &mut H) {
    state.write(text.as_bytes());
    state.write_u8(0xff);
}

impl Hash for JsString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match &self.0 {
            Repr::Utf8(text) => hash_text(text, state),
            Repr::Units(units) => {
                state.write_u8(0xfe);
                for unit in units.iter() {
                    state.write_u16(*unit);
                }
            }
        }
    }
}

/// JavaScript's string order: by UTF-16 code unit, which differs from Rust's code point order
/// for characters above U+FFFF against U+E000..U+FFFF.
impl Ord for JsString {
    fn cmp(&self, other: &JsString) -> Ordering {
        if let (Some(a), Some(b)) = (self.as_str(), other.as_str())
            && (a.is_ascii() || b.is_ascii())
        {
            return a.cmp(b);
        }
        self.units().cmp(other.units())
    }
}

impl PartialOrd for JsString {
    fn partial_cmp(&self, other: &JsString) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_string_lossy())
    }
}

impl fmt::Debug for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        crate::write::write_js_string(&mut out, self);
        f.write_str(&out)
    }
}
