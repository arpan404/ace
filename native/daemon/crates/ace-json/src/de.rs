// SPDX-License-Identifier: Apache-2.0
//! A serde `Deserializer` over a [`Value`]: typed facts and states decode from the tree
//! `JSON.parse` built, so a number keeps the exact double its text named and a draft keeps
//! JavaScript's key order. (serde_json's own float path rounds a 17-digit number to the double
//! of its shortest text: `0.0009910000000000001` reads back `0.000991`, a different value.)
//!
//! Numbers visit as integers when they are integral and in range, else as `f64`, so both
//! `z.number().int()` fields and plain `f64` fields read what JavaScript holds.
//!
//! Decoding is recursive (serde's structs and tagged enums walk down the tree), so nesting is
//! bounded: a fact or state nested past `MAX_DEPTH` fails as an invalid value, which the fold
//! turns into a rejection notice. Parsing itself is iterative; only this decode has a budget.
//!
//! Decoding into typed Rust values recurses (a struct's visitor calls back for each nested
//! value, and an internally tagged enum buffers through serde's content tree), so nesting is
//! bounded: a document deeper than [`MAX_DEPTH`] fails with an error instead of growing the
//! stack. The parser itself is iterative and has no such limit.

use std::fmt;

use serde::de::value::StrDeserializer;
use serde::de::{self, DeserializeSeed, Visitor};
use serde::forward_to_deserialize_any;

use crate::number::Number;
use crate::object::Map;
use crate::string::JsString;
use crate::value::Value;

/// Why a value could not be read as the requested type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl de::Error for Error {
    fn custom<T: fmt::Display>(message: T) -> Error {
        Error(message.to_string())
    }
}

type Result<T> = std::result::Result<T, Error>;

/// The token [`JsString`] asks for: its UTF-16 units, a lone surrogate included.
pub const JS_STRING_TOKEN: &str = "$ace_json::JsString";

/// The deepest document typed decoding accepts. Each level costs a handful of stack frames in
/// serde's visitors, so this keeps a pathological payload an error rather than a crash; real
/// provider data, and the diagnostics capture's own limit of 100, stay well inside it.
pub const MAX_DEPTH: u32 = 256;

/// A value to decode, and how deep inside its document it sits.
#[derive(Clone, Copy)]
pub struct Deserializer<'de> {
    value: &'de Value,
    depth: u32,
}

impl<'de> Deserializer<'de> {
    /// Decode a whole document.
    pub fn new(value: &'de Value) -> Deserializer<'de> {
        Deserializer { value, depth: 0 }
    }

    /// The value one level deeper, or an error when the document is too deep.
    fn child(value: &'de Value, depth: u32) -> Result<Deserializer<'de>> {
        if depth > MAX_DEPTH {
            return Err(Error(format!(
                "document nests deeper than {MAX_DEPTH} levels"
            )));
        }
        Ok(Deserializer { value, depth })
    }
}

impl<'de> de::Deserializer<'de> for Deserializer<'de> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
        match self.value {
            Value::Null => visitor.visit_unit(),
            Value::Bool(flag) => visitor.visit_bool(*flag),
            Value::Number(number) => visit_number(number, visitor),
            Value::String(text) => match crate::string::to_rust_text(text) {
                // The string is its own Rust text (no surrogate, no marker): borrow it.
                std::borrow::Cow::Borrowed(text) => visitor.visit_borrowed_str(text),
                // A lone surrogate (or a literal marker) travels as Rust text that keeps every
                // unit, and writes back as the same JavaScript string.
                std::borrow::Cow::Owned(text) => visitor.visit_string(text),
            },
            Value::Array(items) => visitor.visit_seq(SeqAccess {
                items: items.iter(),
                depth: self.depth,
            }),
            Value::Object(map) => visitor.visit_map(MapAccess {
                entries: map.iter(),
                value: None,
                depth: self.depth,
            }),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value> {
        match (name, self.value) {
            (JS_STRING_TOKEN, Value::String(text)) => match text.as_well_formed() {
                Some(text) => visitor.visit_str(text),
                None => {
                    let mut bytes = Vec::with_capacity(text.len_utf16() * 2);
                    for unit in text.units() {
                        bytes.extend_from_slice(&unit.to_le_bytes());
                    }
                    visitor.visit_byte_buf(bytes)
                }
            },
            _ => self.deserialize_any(visitor),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value> {
        match self.value {
            Value::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    /// A unit enum arrives as its renamed string (`"thread"`); serde's derived enums ask for
    /// `deserialize_enum`, so the string becomes the variant identifier.
    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value> {
        match self.value {
            Value::String(text) => visitor.visit_enum(UnitVariant {
                name: text.as_str(),
            }),
            Value::Object(map) if map.len() == 1 => match map.iter().next() {
                Some((name, value)) => visitor.visit_enum(MapVariant {
                    name: name.as_str(),
                    value,
                }),
                None => Err(de::Error::custom("an enum needs one key")),
            },
            _ => Err(de::Error::custom(
                "an enum must be a string or one-key object",
            )),
        }
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct seq tuple tuple_struct map struct
        identifier ignored_any
    }
}

/// One unit variant named by a string, as serde's derived enum visitor reads it.
struct UnitVariant<'a> {
    name: &'a str,
}

impl<'de> de::EnumAccess<'de> for UnitVariant<'de> {
    type Error = Error;
    type Variant = Self;

    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Self)> {
        let value = seed.deserialize(de::value::StrDeserializer::<Error>::new(self.name))?;
        Ok((value, self))
    }
}

/// One externally tagged variant: its name and the value beside it.
struct MapVariant<'a, 'de> {
    name: &'a str,
    value: &'de Value,
}

impl<'de> de::EnumAccess<'de> for MapVariant<'_, 'de> {
    type Error = Error;
    type Variant = Self;

    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Self)> {
        let value = seed.deserialize(de::value::StrDeserializer::<Error>::new(self.name))?;
        Ok((value, self))
    }
}

impl<'de> de::VariantAccess<'de> for MapVariant<'_, 'de> {
    type Error = Error;

    fn unit_variant(self) -> Result<()> {
        match self.value {
            Value::Null => Ok(()),
            _ => Err(de::Error::custom("a unit variant carries no value")),
        }
    }

    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value> {
        seed.deserialize(Deserializer::new(self.value))
    }

    fn tuple_variant<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value> {
        <Deserializer as de::Deserializer>::deserialize_tuple(
            Deserializer::new(self.value),
            len,
            visitor,
        )
    }

    fn struct_variant<V: Visitor<'de>>(
        self,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value> {
        <Deserializer as de::Deserializer>::deserialize_struct(
            Deserializer::new(self.value),
            "",
            fields,
            visitor,
        )
    }
}

impl<'de> de::VariantAccess<'de> for UnitVariant<'de> {
    type Error = Error;

    fn unit_variant(self) -> Result<()> {
        Ok(())
    }

    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, _seed: T) -> Result<T::Value> {
        Err(de::Error::custom("an enum value is a unit variant"))
    }

    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, _visitor: V) -> Result<V::Value> {
        Err(de::Error::custom("an enum value is a unit variant"))
    }

    fn struct_variant<V: Visitor<'de>>(
        self,
        _fields: &'static [&'static str],
        _visitor: V,
    ) -> Result<V::Value> {
        Err(de::Error::custom("an enum value is a unit variant"))
    }
}

/// A number as an integer when JavaScript's value is one in range, else as a double.
fn visit_number<'de, V: Visitor<'de>>(number: &Number, visitor: V) -> Result<V::Value> {
    if let Some(int) = number.as_i64() {
        visitor.visit_i64(int)
    } else if let Some(int) = number.as_u64() {
        visitor.visit_u64(int)
    } else {
        visitor.visit_f64(number.value())
    }
}

struct SeqAccess<'a> {
    items: std::slice::Iter<'a, Value>,
    depth: u32,
}

impl<'de> de::SeqAccess<'de> for SeqAccess<'de> {
    type Error = Error;

    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>> {
        match self.items.next() {
            None => Ok(None),
            Some(value) => seed
                .deserialize(Deserializer::child(value, self.depth + 1)?)
                .map(Some),
        }
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.items.len())
    }
}

struct MapAccess<'a> {
    entries: indexmap::map::Iter<'a, JsString, Value>,
    value: Option<&'a Value>,
    depth: u32,
}

impl<'de> de::MapAccess<'de> for MapAccess<'de> {
    type Error = Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>> {
        match self.entries.next() {
            None => Ok(None),
            Some((key, value)) => {
                self.value = Some(value);
                let key: StrDeserializer<'de, Error> = match key.as_well_formed() {
                    Some(text) => StrDeserializer::new(text),
                    None => {
                        return Err(Error("lone surrogates are not valid UTF-8 text".to_owned()));
                    }
                };
                seed.deserialize(key).map(Some)
            }
        }
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value> {
        match self.value.take() {
            Some(value) => seed.deserialize(Deserializer::child(value, self.depth + 1)?),
            None => Err(Error("a map value was read before its key".to_owned())),
        }
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.entries.len())
    }
}

/// Read a typed value from a parsed [`Value`].
pub fn from_value<'de, T: serde::Deserialize<'de>>(value: &'de Value) -> Result<T> {
    T::deserialize(Deserializer::new(value))
}

impl<'de> serde::Deserialize<'de> for Value {
    fn deserialize<D: de::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Value, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_bool<E: de::Error>(self, flag: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(flag))
    }

    fn visit_i64<E: de::Error>(self, int: i64) -> std::result::Result<Value, E> {
        Ok(Value::Number(Number::from(int)))
    }

    fn visit_u64<E: de::Error>(self, int: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(Number::from(int)))
    }

    fn visit_f64<E: de::Error>(self, number: f64) -> std::result::Result<Value, E> {
        Ok(Value::Number(Number::from_f64_lossy(number)))
    }

    fn visit_str<E: de::Error>(self, text: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(JsString::from(text)))
    }

    fn visit_string<E: de::Error>(self, text: String) -> std::result::Result<Value, E> {
        Ok(Value::String(JsString::from(text)))
    }

    fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items.into()))
    }

    fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut entries = Map::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((key, value)) = map.next_entry::<JsString, Value>()? {
            entries.insert(key, value);
        }
        Ok(Value::Object(entries))
    }
}

impl<'de> serde::Deserialize<'de> for Map {
    fn deserialize<D: de::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Map, D::Error> {
        deserializer.deserialize_map(MapVisitor)
    }
}

struct MapVisitor;

impl<'de> Visitor<'de> for MapVisitor {
    type Value = Map;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<Map, A::Error> {
        let mut entries = Map::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((key, value)) = map.next_entry::<JsString, Value>()? {
            entries.insert(key, value);
        }
        Ok(entries)
    }
}

impl<'de> serde::Deserialize<'de> for JsString {
    fn deserialize<D: de::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<JsString, D::Error> {
        deserializer.deserialize_str(JsStringVisitor)
    }
}

struct JsStringVisitor;

impl Visitor<'_> for JsStringVisitor {
    type Value = JsString;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a string")
    }

    fn visit_str<E: de::Error>(self, text: &str) -> std::result::Result<JsString, E> {
        Ok(JsString::from(text))
    }

    fn visit_string<E: de::Error>(self, text: String) -> std::result::Result<JsString, E> {
        Ok(JsString::from(text))
    }

    /// The units the doorway handed over: little-endian UTF-16, a lone surrogate included.
    #[allow(clippy::chunks_exact_to_as_chunks)]
    fn visit_bytes<E: de::Error>(self, bytes: &[u8]) -> std::result::Result<JsString, E> {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Ok(JsString::from_units(&units))
    }

    fn visit_byte_buf<E: de::Error>(self, bytes: Vec<u8>) -> std::result::Result<JsString, E> {
        self.visit_bytes(&bytes)
    }
}
