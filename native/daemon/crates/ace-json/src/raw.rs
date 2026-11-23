// SPDX-License-Identifier: Apache-2.0
//! Serialized JSON kept as text. [`Raw`] owns canonical text (exactly `JSON.stringify`'s
//! output for its value), so it splices into output verbatim. [`RawRef`] borrows one value of
//! a validated document: a translator reads the few fields it needs from a frame and passes
//! the rest through without building a tree; when the document was canonical (the shells send
//! `JSON.stringify` output) every sub-value splices verbatim.

use std::borrow::Cow;
use std::fmt;

use crate::number::Number;
use crate::parse::{Cursor, SyntaxError, parse};
use crate::scan::{skip_string, skip_value, skip_ws, validate};
use crate::string::JsString;
use crate::value::Value;
use crate::write::{to_string, write_value};

/// Canonical JSON text for one value.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Raw(Box<str>);

impl Raw {
    pub fn null() -> Raw {
        Raw("null".into())
    }

    pub fn from_value(value: &Value) -> Raw {
        Raw(to_string(value).into_boxed_str())
    }

    /// Validate `text`; kept as is when canonical, else re-encoded as `JSON.stringify` would.
    pub fn from_json(text: &str) -> Result<Raw, SyntaxError> {
        let trimmed = text.trim_matches([' ', '\t', '\n', '\r']);
        Ok(match validate(trimmed)? {
            true => Raw(trimmed.into()),
            false => Raw::from_value(&parse(trimmed)?),
        })
    }

    /// As [`Raw::from_json`], reusing the allocation when the text is already canonical.
    pub fn from_string(text: String) -> Result<Raw, SyntaxError> {
        if validate(&text)? {
            Ok(Raw(text.into_boxed_str()))
        } else {
            Raw::from_json(&text)
        }
    }

    /// JSON.stringify's text, written by this crate's writer: no check needed.
    pub(crate) fn from_canonical(text: String) -> Raw {
        Raw(text.into_boxed_str())
    }

    pub fn get(&self) -> &str {
        &self.0
    }

    pub fn view(&self) -> RawRef<'_> {
        RawRef {
            text: &self.0,
            canonical: true,
        }
    }

    pub fn to_value(&self) -> Value {
        self.view().to_value()
    }

    pub fn into_string(self) -> String {
        self.0.into_string()
    }
}

impl AsRef<Raw> for Raw {
    fn as_ref(&self) -> &Raw {
        self
    }
}

impl Default for Raw {
    fn default() -> Raw {
        Raw::null()
    }
}

impl fmt::Debug for Raw {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Display for Raw {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&Value> for Raw {
    fn from(value: &Value) -> Raw {
        Raw::from_value(value)
    }
}

/// The kind of a JSON value, from its first byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}

/// One value of a validated JSON document, borrowed.
#[derive(Clone, Copy)]
pub struct RawRef<'a> {
    text: &'a str,
    canonical: bool,
}

/// Validate `text` as one JSON value and borrow it.
pub fn parse_raw(text: &str) -> Result<RawRef<'_>, SyntaxError> {
    let trimmed = text.trim_matches([' ', '\t', '\n', '\r']);
    let canonical = validate(trimmed)?;
    Ok(RawRef {
        text: trimmed,
        canonical,
    })
}

impl<'a> RawRef<'a> {
    /// The value's text as written in its document.
    pub fn text(&self) -> &'a str {
        self.text
    }

    /// Whether [`RawRef::text`] is exactly what `JSON.stringify` writes for this value.
    pub fn is_canonical(&self) -> bool {
        self.canonical
    }

    pub fn kind(&self) -> Kind {
        match self.text.as_bytes().first() {
            Some(b'{') => Kind::Object,
            Some(b'[') => Kind::Array,
            Some(b'"') => Kind::String,
            Some(b't' | b'f') => Kind::Bool,
            Some(b'n') | None => Kind::Null,
            Some(_) => Kind::Number,
        }
    }

    fn sub(&self, start: usize, end: usize) -> RawRef<'a> {
        RawRef {
            text: self.text.get(start..end).unwrap_or("null"),
            canonical: self.canonical,
        }
    }

    /// The members of an object, in document order (a duplicate key appears twice).
    pub fn entries(&self) -> Entries<'a> {
        let bytes = self.text.as_bytes();
        let at = match bytes.first() {
            Some(b'{') => skip_ws(bytes, 1),
            _ => bytes.len(),
        };
        Entries { doc: *self, at }
    }

    /// The items of an array.
    pub fn items(&self) -> Items<'a> {
        let bytes = self.text.as_bytes();
        let at = match bytes.first() {
            Some(b'[') => skip_ws(bytes, 1),
            _ => bytes.len(),
        };
        Items { doc: *self, at }
    }

    /// `value[key]` of an object: the last member so named, as `JSON.parse` keeps it.
    pub fn get(&self, key: &str) -> Option<RawRef<'a>> {
        let mut found = None;
        for (name, value) in self.entries() {
            if name.key_is(key) {
                if self.canonical {
                    return Some(value);
                }
                found = Some(value);
            }
        }
        found
    }

    /// `value[index]` of an array.
    pub fn at(&self, index: usize) -> Option<RawRef<'a>> {
        self.items().nth(index)
    }

    fn key_is(&self, key: &str) -> bool {
        let inner = self
            .text
            .get(1..self.text.len().saturating_sub(1))
            .unwrap_or("");
        if !inner.contains('\\') {
            return inner == key;
        }
        self.as_js_string().is_some_and(|name| name == key)
    }

    /// A string's text, borrowed when it has no escapes; `None` for other kinds. A lone
    /// surrogate reads as U+FFFD, as [`crate::JsString`] derefs; [`RawRef::as_js_string`] keeps it.
    pub fn as_str(&self) -> Option<Cow<'a, str>> {
        let inner = self.text.strip_prefix('"')?.strip_suffix('"')?;
        if !inner.contains('\\') {
            return Some(Cow::Borrowed(inner));
        }
        self.as_js_string().map(|text| Cow::Owned(String::from(text)))
    }

    pub fn as_js_string(&self) -> Option<JsString> {
        let mut cursor = Cursor::new(self.text);
        if cursor.peek() != Some(b'"') {
            return None;
        }
        cursor.pos = 1;
        cursor.string().ok()
    }

    pub fn as_number(&self) -> Option<Number> {
        match self.kind() {
            Kind::Number => self.text.parse::<f64>().ok().map(Number::from_f64_lossy),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        self.as_number().map(|number| number.value())
    }

    pub fn as_i64(&self) -> Option<i64> {
        self.as_number().and_then(|number| number.as_i64())
    }

    pub fn as_u64(&self) -> Option<u64> {
        self.as_number().and_then(|number| number.as_u64())
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self.text {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        self.text == "null"
    }

    /// `JSON.parse` of this value.
    pub fn to_value(&self) -> Value {
        parse(self.text).unwrap_or(Value::Null)
    }

    /// An owned canonical copy.
    pub fn to_raw(&self) -> Raw {
        if self.canonical {
            Raw(self.text.into())
        } else {
            Raw::from_value(&self.to_value())
        }
    }

    /// Append `JSON.stringify(JSON.parse(text))`: the text itself when canonical.
    pub fn write_to(&self, out: &mut String) {
        if self.canonical {
            out.push_str(self.text);
        } else {
            write_value(out, &self.to_value());
        }
    }
}

impl fmt::Debug for RawRef<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.text)
    }
}

/// An object's members, from [`RawRef::entries`]: each key (a string literal) and its value.
pub struct Entries<'a> {
    doc: RawRef<'a>,
    at: usize,
}

impl<'a> Iterator for Entries<'a> {
    type Item = (RawRef<'a>, RawRef<'a>);
    fn next(&mut self) -> Option<Self::Item> {
        let bytes = self.doc.text.as_bytes();
        if bytes.get(self.at) != Some(&b'"') {
            self.at = bytes.len();
            return None;
        }
        let key_end = skip_string(bytes, self.at + 1);
        let key = self.doc.sub(self.at, key_end);
        // Past the colon and the whitespace around it.
        let start = skip_ws(bytes, skip_ws(bytes, key_end) + 1);
        let end = skip_value(bytes, start);
        let value = self.doc.sub(start, end);
        let after = skip_ws(bytes, end);
        self.at = match bytes.get(after) {
            Some(b',') => skip_ws(bytes, after + 1),
            _ => bytes.len(),
        };
        Some((key, value))
    }
}

/// An array's items, from [`RawRef::items`].
pub struct Items<'a> {
    doc: RawRef<'a>,
    at: usize,
}

impl<'a> Iterator for Items<'a> {
    type Item = RawRef<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        let bytes = self.doc.text.as_bytes();
        match bytes.get(self.at) {
            None | Some(b']') => {
                self.at = bytes.len();
                return None;
            }
            Some(_) => {}
        }
        let end = skip_value(bytes, self.at);
        let item = self.doc.sub(self.at, end);
        let after = skip_ws(bytes, end);
        self.at = match bytes.get(after) {
            Some(b',') => skip_ws(bytes, after + 1),
            _ => bytes.len(),
        };
        Some(item)
    }
}
