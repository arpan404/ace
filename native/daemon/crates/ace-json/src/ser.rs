// SPDX-License-Identifier: Apache-2.0
//! A serde `Serializer` that writes `JSON.stringify`'s bytes: numbers as JavaScript numbers
//! (integers past 2^53 round, `1.0` writes `1`, non-finite writes `null`), strings escaped as
//! [`crate::write`] does, `None` and units as `null`. [`Raw`], [`RawRef`], [`Value`] and
//! [`JsString`] splice their text verbatim through it; under another serializer they would not,
//! so serialize them with [`to_string`] only.

use serde::ser::{self, Serialize};
use std::fmt;

use crate::number::{Number, write_number};
use crate::raw::{Raw, RawRef};
use crate::string::JsString;
use crate::value::Value;
use crate::write::{write_js_string, write_str, write_value};

const RAW_TOKEN: &str = "$ace_json::Raw";

/// Already-serialized JSON text, spliced verbatim by [`to_string`]/[`write_into`]: what a crate
/// that wrote its own bytes (numbers and escapes included) hands back to the serializer.
pub struct PreSpliced<'a>(pub &'a str);

impl Serialize for PreSpliced<'_> {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(RAW_TOKEN, self.0)
    }
}

/// Why a value could not be serialized: a custom `Serialize` failed or a map key was not a
/// string or number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl ser::Error for Error {
    fn custom<T: fmt::Display>(message: T) -> Error {
        Error(message.to_string())
    }
}

type Result<T = ()> = std::result::Result<T, Error>;

/// `JSON.stringify(value)` for anything serde can serialize.
pub fn to_string<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    let mut out = String::with_capacity(128);
    value.serialize(&mut Writer { out: &mut out })?;
    Ok(out)
}

/// Append `JSON.stringify(value)` to an existing buffer, so one response is built in one place.
pub fn write_into<T: Serialize + ?Sized>(out: &mut String, value: &T) -> Result<()> {
    value.serialize(&mut Writer { out })
}

/// As [`to_string`], as canonical [`Raw`] text.
pub fn to_raw<T: Serialize + ?Sized>(value: &T) -> Result<Raw> {
    to_string(value).map(Raw::from_canonical)
}

/// Appends to a string.
pub struct Writer<'o> {
    out: &'o mut String,
}

/// One open array or object: whether a member was written yet.
pub struct Compound<'w, 'o> {
    writer: &'w mut Writer<'o>,
    wrote: bool,
    /// Closing text: `]`, `}` or `}}` for a variant's wrapper.
    close: &'static str,
}

impl Compound<'_, '_> {
    fn comma(&mut self) {
        if std::mem::replace(&mut self.wrote, true) {
            self.writer.out.push(',');
        }
    }
}

macro_rules! number_methods {
    ($($method:ident: $t:ty),*) => {$(
        fn $method(self, value: $t) -> Result {
            write_number(self.out, value as f64);
            Ok(())
        }
    )*};
}

impl<'w, 'o> ser::Serializer for &'w mut Writer<'o> {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = Compound<'w, 'o>;
    type SerializeTuple = Compound<'w, 'o>;
    type SerializeTupleStruct = Compound<'w, 'o>;
    type SerializeTupleVariant = Compound<'w, 'o>;
    type SerializeMap = Compound<'w, 'o>;
    type SerializeStruct = Compound<'w, 'o>;
    type SerializeStructVariant = Compound<'w, 'o>;

    fn serialize_bool(self, value: bool) -> Result {
        self.out.push_str(if value { "true" } else { "false" });
        Ok(())
    }

    number_methods!(
        serialize_i8: i8, serialize_i16: i16, serialize_i32: i32, serialize_i64: i64,
        serialize_i128: i128, serialize_u8: u8, serialize_u16: u16, serialize_u32: u32,
        serialize_u64: u64, serialize_u128: u128, serialize_f32: f32, serialize_f64: f64
    );

    fn serialize_char(self, value: char) -> Result {
        write_str(self.out, value.encode_utf8(&mut [0u8; 4]));
        Ok(())
    }

    fn serialize_str(self, value: &str) -> Result {
        write_str(self.out, value);
        Ok(())
    }

    fn serialize_bytes(self, value: &[u8]) -> Result {
        use ser::SerializeSeq;
        let mut seq = self.serialize_seq(Some(value.len()))?;
        for byte in value {
            seq.serialize_element(byte)?;
        }
        seq.end()
    }

    fn serialize_none(self) -> Result {
        self.serialize_unit()
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Result {
        self.out.push_str("null");
        Ok(())
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result {
        self.serialize_unit()
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result {
        self.serialize_str(variant)
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result {
        if name == RAW_TOKEN {
            return value.serialize(Splice { out: self.out });
        }
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result {
        self.out.push('{');
        write_str(self.out, variant);
        self.out.push(':');
        value.serialize(&mut *self)?;
        self.out.push('}');
        Ok(())
    }

    fn serialize_seq(self, _len: Option<usize>) -> Result<Compound<'w, 'o>> {
        self.out.push('[');
        Ok(Compound {
            writer: self,
            wrote: false,
            close: "]",
        })
    }

    fn serialize_tuple(self, len: usize) -> Result<Compound<'w, 'o>> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<Compound<'w, 'o>> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Compound<'w, 'o>> {
        self.out.push('{');
        write_str(self.out, variant);
        self.out.push_str(":[");
        Ok(Compound {
            writer: self,
            wrote: false,
            close: "]}",
        })
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<Compound<'w, 'o>> {
        self.out.push('{');
        Ok(Compound {
            writer: self,
            wrote: false,
            close: "}",
        })
    }

    fn serialize_struct(self, _name: &'static str, len: usize) -> Result<Compound<'w, 'o>> {
        self.serialize_map(Some(len))
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Compound<'w, 'o>> {
        self.out.push('{');
        write_str(self.out, variant);
        self.out.push_str(":{");
        Ok(Compound {
            writer: self,
            wrote: false,
            close: "}}",
        })
    }
}

impl ser::SerializeSeq for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result {
        self.comma();
        value.serialize(&mut *self.writer)
    }
    fn end(self) -> Result {
        self.writer.out.push_str(self.close);
        Ok(())
    }
}

impl ser::SerializeTuple for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleVariant for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeMap for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result {
        self.comma();
        key.serialize(KeyWriter {
            out: self.writer.out,
        })?;
        self.writer.out.push(':');
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result {
        value.serialize(&mut *self.writer)
    }
    fn end(self) -> Result {
        self.writer.out.push_str(self.close);
        Ok(())
    }
}

impl ser::SerializeStruct for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result {
        self.comma();
        write_str(self.writer.out, key);
        self.writer.out.push(':');
        value.serialize(&mut *self.writer)
    }
    fn end(self) -> Result {
        self.writer.out.push_str(self.close);
        Ok(())
    }
}

impl ser::SerializeStructVariant for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result {
        ser::SerializeStruct::serialize_field(self, key, value)
    }
    fn end(self) -> Result {
        ser::SerializeStruct::end(self)
    }
}

mod splice;
use splice::{KeyWriter, Splice};

impl Serialize for Raw {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_newtype_struct(RAW_TOKEN, self.get())
    }
}

impl Serialize for RawRef<'_> {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut text = String::new();
        self.write_to(&mut text);
        serializer.serialize_newtype_struct(RAW_TOKEN, &text)
    }
}

impl Serialize for Value {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut text = String::new();
        write_value(&mut text, self);
        serializer.serialize_newtype_struct(RAW_TOKEN, &text)
    }
}

impl Serialize for crate::Map {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut text = String::new();
        crate::write::write_map(&mut text, self);
        serializer.serialize_newtype_struct(RAW_TOKEN, &text)
    }
}

impl Serialize for crate::Array {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut text = String::new();
        crate::write::write_items(&mut text, self);
        serializer.serialize_newtype_struct(RAW_TOKEN, &text)
    }
}

impl Serialize for JsString {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self.as_well_formed() {
            Some(text) => serializer.serialize_str(text),
            None => {
                let mut text = String::new();
                write_js_string(&mut text, self);
                serializer.serialize_newtype_struct(RAW_TOKEN, &text)
            }
        }
    }
}

impl Serialize for Number {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_f64(self.value())
    }
}
