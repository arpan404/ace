// SPDX-License-Identifier: Apache-2.0
//! The two narrow serializers the writer hands values to: [`Splice`] appends already
//! serialized text verbatim, [`KeyWriter`] writes an object key as `String(key)` would.

use serde::ser::{self, Impossible, Serialize};

use super::Error;
use crate::number::write_number;
use crate::write::write_str;

type Result<T = ()> = std::result::Result<T, Error>;

fn refuse<T>(what: &str) -> Result<T> {
    Err(Error(format!("{what} cannot be used here")))
}

/// Methods a narrow serializer refuses.
macro_rules! refuse {
    ($($method:ident($($arg:ty),*)),* $(,)?) => {$(
        fn $method(self, $(_: $arg),*) -> Result {
            refuse(stringify!($method))
        }
    )*};
}

macro_rules! refuse_compound {
    () => {
        fn serialize_some<T: Serialize + ?Sized>(self, _: &T) -> Result {
            refuse("an option")
        }
        fn serialize_newtype_variant<T: Serialize + ?Sized>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: &T,
        ) -> Result {
            refuse("an enum")
        }
        fn serialize_seq(self, _: Option<usize>) -> Result<Impossible<(), Error>> {
            refuse("a sequence")
        }
        fn serialize_tuple(self, _: usize) -> Result<Impossible<(), Error>> {
            refuse("a tuple")
        }
        fn serialize_tuple_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Impossible<(), Error>> {
            refuse("a tuple")
        }
        fn serialize_tuple_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Impossible<(), Error>> {
            refuse("an enum")
        }
        fn serialize_map(self, _: Option<usize>) -> Result<Impossible<(), Error>> {
            refuse("a map")
        }
        fn serialize_struct(self, _: &'static str, _: usize) -> Result<Impossible<(), Error>> {
            refuse("a struct")
        }
        fn serialize_struct_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Impossible<(), Error>> {
            refuse("an enum")
        }
    };
}

/// Appends a string as JSON text, unescaped.
pub(super) struct Splice<'o> {
    pub(super) out: &'o mut String,
}

impl ser::Serializer for Splice<'_> {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = Impossible<(), Error>;
    type SerializeTuple = Impossible<(), Error>;
    type SerializeTupleStruct = Impossible<(), Error>;
    type SerializeTupleVariant = Impossible<(), Error>;
    type SerializeMap = Impossible<(), Error>;
    type SerializeStruct = Impossible<(), Error>;
    type SerializeStructVariant = Impossible<(), Error>;

    fn serialize_str(self, text: &str) -> Result {
        self.out.push_str(text);
        Ok(())
    }

    refuse!(
        serialize_bool(bool),
        serialize_i8(i8),
        serialize_i16(i16),
        serialize_i32(i32),
        serialize_i64(i64),
        serialize_u8(u8),
        serialize_u16(u16),
        serialize_u32(u32),
        serialize_u64(u64),
        serialize_f32(f32),
        serialize_f64(f64),
        serialize_char(char),
        serialize_bytes(&[u8]),
        serialize_none(),
        serialize_unit(),
        serialize_unit_struct(&'static str),
        serialize_unit_variant(&'static str, u32, &'static str),
    );

    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _: &'static str, value: &T) -> Result {
        value.serialize(self)
    }

    refuse_compound!();
}

/// Writes an object key: a string as is, a number as `String(number)`.
pub(super) struct KeyWriter<'o> {
    pub(super) out: &'o mut String,
}

impl KeyWriter<'_> {
    fn number(self, value: f64) -> Result {
        let mut text = String::new();
        write_number(&mut text, value);
        write_str(self.out, &text);
        Ok(())
    }
}

macro_rules! number_keys {
    ($($method:ident: $t:ty),*) => {$(
        fn $method(self, value: $t) -> Result {
            self.number(value as f64)
        }
    )*};
}

impl ser::Serializer for KeyWriter<'_> {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = Impossible<(), Error>;
    type SerializeTuple = Impossible<(), Error>;
    type SerializeTupleStruct = Impossible<(), Error>;
    type SerializeTupleVariant = Impossible<(), Error>;
    type SerializeMap = Impossible<(), Error>;
    type SerializeStruct = Impossible<(), Error>;
    type SerializeStructVariant = Impossible<(), Error>;

    fn serialize_str(self, text: &str) -> Result {
        write_str(self.out, text);
        Ok(())
    }

    fn serialize_char(self, value: char) -> Result {
        write_str(self.out, value.encode_utf8(&mut [0u8; 4]));
        Ok(())
    }

    number_keys!(
        serialize_i8: i8, serialize_i16: i16, serialize_i32: i32, serialize_i64: i64,
        serialize_u8: u8, serialize_u16: u16, serialize_u32: u32, serialize_u64: u64,
        serialize_f32: f32, serialize_f64: f64
    );

    fn serialize_unit_variant(self, _: &'static str, _: u32, variant: &'static str) -> Result {
        self.serialize_str(variant)
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result {
        if name == super::RAW_TOKEN {
            return value.serialize(Splice { out: self.out });
        }
        value.serialize(self)
    }

    refuse!(
        serialize_bool(bool),
        serialize_bytes(&[u8]),
        serialize_none(),
        serialize_unit(),
        serialize_unit_struct(&'static str),
    );

    refuse_compound!();
}
