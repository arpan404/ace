// SPDX-License-Identifier: Apache-2.0
//! Strings as JavaScript holds them: a sequence of UTF-16 code units, where a lone surrogate
//! (`"\ud800"`) is an ordinary string. Nearly every string is well-formed, so those stay a Rust
//! `String` (cheap `&str` reads, byte-wise lookups); only a string holding a lone surrogate keeps
//! its code units, beside a display text with U+FFFD for each lone surrogate. The two forms
//! never describe the same string, so equality and hashing compare them form by form.
//!
//! A `JsString` derefs to its text, so code reads it as a `&str`; the text is exact for every
//! well-formed string. Equality, order, length in code units, concatenation and serializing use
//! the code units, so a lone surrogate survives a copy into another value and out to JSON.

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
    /// Holds at least one lone surrogate; never a well-formed string. `text` is the display
    /// form, each lone surrogate replaced by U+FFFD.
    Units {
        units: Box<[u16]>,
        text: String,
    },
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

    /// A shared empty string, for defaults that borrow.
    pub fn empty() -> &'static JsString {
        static EMPTY: JsString = JsString::new();
        &EMPTY
    }

    /// The string of these UTF-16 code units, pairing surrogates as JavaScript does.
    pub fn from_units(units: &[u16]) -> JsString {
        let mut text = String::with_capacity(units.len());
        for decoded in char::decode_utf16(units.iter().copied()) {
            match decoded {
                Ok(c) => text.push(c),
                Err(_) => {
                    let text = char::decode_utf16(units.iter().copied())
                        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
                        .collect();
                    return JsString(Repr::Units {
                        units: units.into(),
                        text,
                    });
                }
            }
        }
        JsString(Repr::Utf8(text))
    }

    /// The text when the string is well-formed; `None` when it holds a lone surrogate.
    pub fn as_well_formed(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8(text) => Some(text),
            Repr::Units { .. } => None,
        }
    }

    /// The text, each lone surrogate shown as U+FFFD (exact for a well-formed string).
    pub fn as_str(&self) -> &str {
        match &self.0 {
            Repr::Utf8(text) => text,
            Repr::Units { text, .. } => text,
        }
    }

    /// The text, each lone surrogate replaced by U+FFFD.
    pub fn to_string_lossy(&self) -> Cow<'_, str> {
        Cow::Borrowed(self.as_str())
    }

    /// The text, owned, when well-formed.
    pub fn into_string(self) -> Result<String, JsString> {
        match self.0 {
            Repr::Utf8(text) => Ok(text),
            units @ Repr::Units { .. } => Err(JsString(units)),
        }
    }

    /// The string's UTF-16 code units, as JavaScript indexes them.
    pub fn units(&self) -> Units<'_> {
        match &self.0 {
            Repr::Utf8(text) => Units::Utf8(text.encode_utf16()),
            Repr::Units { units, .. } => Units::Slice(units.iter()),
        }
    }

    /// The UTF-16 code units, named as `str::encode_utf16` is so ported code reads the same.
    pub fn encode_utf16(&self) -> Units<'_> {
        self.units()
    }

    /// `string.length`: the count of UTF-16 code units.
    pub fn len_utf16(&self) -> usize {
        match &self.0 {
            Repr::Utf8(text) => text.encode_utf16().count(),
            Repr::Units { units, .. } => units.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Repr::Utf8(text) => text.is_empty(),
            Repr::Units { units, .. } => units.is_empty(),
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
            Repr::Units { .. } => self.push_js(&JsString::from(more)),
        }
    }

    /// `string.startsWith(prefix)`, by code units.
    pub fn starts_with_js(&self, prefix: &JsString) -> bool {
        match (self.as_well_formed(), prefix.as_well_formed()) {
            (Some(text), Some(prefix)) => text.starts_with(prefix),
            _ => {
                let mut units = self.units();
                prefix.units().all(|unit| units.next() == Some(unit))
            }
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
            Repr::Units { units, .. } => Some(units),
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

impl FromIterator<u16> for JsString {
    /// The string of these UTF-16 code units.
    fn from_iter<I: IntoIterator<Item = u16>>(iter: I) -> JsString {
        let units: Vec<u16> = iter.into_iter().collect();
        JsString::from_units(&units)
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
            (Repr::Units { units: a, .. }, Repr::Units { units: b, .. }) => a == b,
            _ => false,
        }
    }
}

impl Eq for JsString {}

impl PartialEq<&JsString> for JsString {
    fn eq(&self, other: &&JsString) -> bool {
        self == *other
    }
}

impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.as_well_formed() == Some(other)
    }
}

impl PartialEq<&str> for JsString {
    fn eq(&self, other: &&str) -> bool {
        self.as_well_formed() == Some(*other)
    }
}

impl PartialEq<String> for JsString {
    fn eq(&self, other: &String) -> bool {
        self.as_well_formed() == Some(other.as_str())
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
/// The marker a lone surrogate is carried by in Rust text, and the character a literal marker
/// is written as (doubled) so the mapping is one-to-one. A BMP code point, so one character is
/// one UTF-16 unit and doubling survives decoding exactly.
pub(crate) const ESCAPE_MARKER: char = '\u{e000}';

fn marker_hex(unit: u16) -> String {
    format!("{unit:04x}")
}

/// A JavaScript string as Rust text for fields that keep `String`: a lone surrogate is written as
/// [`ESCAPE_MARKER`] and four hex digits, and a literal marker is doubled, so nothing two
/// distinct strings carry is lost. [`crate::write::write_str`] turns it back into the exact JSON
/// bytes, so ids that differ only by a surrogate stay distinct.
pub(crate) fn to_rust_text(text: &JsString) -> Cow<'_, str> {
    match text.as_well_formed() {
        Some(plain) if !plain.contains(ESCAPE_MARKER) => Cow::Borrowed(plain),
        Some(plain) => Cow::Owned(plain.replace(ESCAPE_MARKER, "\u{e000}\u{e000}")),
        None => {
            let mut out = String::with_capacity(text.len_utf16());
            let mut units = text.units().peekable();
            while let Some(unit) = units.next() {
                if is_high(unit)
                    && let Some(&low) = units.peek()
                    && is_low(low)
                {
                    units.next();
                    let code =
                        0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                    out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
                } else if is_high(unit) || is_low(unit) {
                    out.push(ESCAPE_MARKER);
                    out.push_str(&marker_hex(unit));
                } else if char::from_u32(u32::from(unit)) == Some(ESCAPE_MARKER) {
                    out.push(ESCAPE_MARKER);
                    out.push(ESCAPE_MARKER);
                } else {
                    out.push(
                        char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER),
                    );
                }
            }
            Cow::Owned(out)
        }
    }
}

impl JsString {
    /// This string as Rust text that [`crate::write::write_str`] turns back into the same JSON:
    /// the carrier a `String` field keeps when the units include a lone surrogate.
    pub fn to_rust(&self) -> Cow<'_, str> {
        to_rust_text(self)
    }

    /// The string a Rust text carries when it holds an escape; `None` means it is already it.
    pub fn from_rust_text(text: &str) -> Option<JsString> {
        decode_marker(text)
    }
}

/// The exact JavaScript string a Rust text carries, when it holds an escape: `None` means the
/// text is already the string.
pub(crate) fn decode_marker(text: &str) -> Option<JsString> {
    if !text.contains(ESCAPE_MARKER) {
        return None;
    }
    let mut units: Vec<u16> = Vec::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(ESCAPE_MARKER) {
        units.extend(rest.get(..at)?.encode_utf16());
        rest = rest.get(at + ESCAPE_MARKER.len_utf8()..)?;
        if let Some(after) = rest.strip_prefix(ESCAPE_MARKER) {
            units.push(ESCAPE_MARKER as u16);
            rest = after;
            continue;
        }
        let hex = rest.get(..4)?;
        let unit = u16::from_str_radix(hex, 16).ok()?;
        units.push(unit);
        rest = rest.get(4..)?;
    }
    units.extend(rest.encode_utf16());
    Some(JsString::from_units(&units))
}

pub(crate) fn hash_text<H: Hasher>(text: &str, state: &mut H) {
    state.write(text.as_bytes());
    state.write_u8(0xff);
}

impl Hash for JsString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match &self.0 {
            Repr::Utf8(text) => hash_text(text, state),
            Repr::Units { units, .. } => {
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
        if let (Some(a), Some(b)) = (self.as_well_formed(), other.as_well_formed())
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
        f.write_str(self.as_str())
    }
}

impl std::ops::Deref for JsString {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}

impl AsRef<str> for JsString {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl From<JsString> for String {
    /// The text, each lone surrogate replaced by U+FFFD.
    fn from(text: JsString) -> String {
        match text.0 {
            Repr::Utf8(text) => text,
            Repr::Units { text, .. } => text,
        }
    }
}

impl From<&JsString> for String {
    fn from(text: &JsString) -> String {
        text.as_str().to_owned()
    }
}

impl fmt::Debug for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        crate::write::write_js_string(&mut out, self);
        f.write_str(&out)
    }
}
