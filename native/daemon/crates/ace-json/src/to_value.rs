// SPDX-License-Identifier: Apache-2.0
//! `to_value(&x)`: a value from a borrowed Rust value, as `json!` takes its expressions (by
//! reference, like serde_json's macro, so `json!({"a": text})` leaves `text` usable).

use crate::number::Number;
use crate::object::Map;
use crate::string::JsString;
use crate::value::{Array, Value};

/// Types `json!` and [`to_value`] accept.
pub trait ToValue {
    fn to_value(&self) -> Value;
}

/// A value copied from `value`.
pub fn to_value<T: ToValue + ?Sized>(value: &T) -> Value {
    value.to_value()
}

impl<T: ToValue + ?Sized> ToValue for &T {
    fn to_value(&self) -> Value {
        (**self).to_value()
    }
}

impl ToValue for Value {
    fn to_value(&self) -> Value {
        self.clone()
    }
}

impl ToValue for str {
    fn to_value(&self) -> Value {
        Value::String(JsString::from(self))
    }
}

impl ToValue for String {
    fn to_value(&self) -> Value {
        Value::String(JsString::from(self))
    }
}

impl ToValue for JsString {
    fn to_value(&self) -> Value {
        Value::String(self.clone())
    }
}

impl ToValue for bool {
    fn to_value(&self) -> Value {
        Value::Bool(*self)
    }
}

impl ToValue for Number {
    fn to_value(&self) -> Value {
        Value::Number(*self)
    }
}

impl ToValue for Map {
    fn to_value(&self) -> Value {
        Value::Object(self.clone())
    }
}

impl ToValue for Array {
    fn to_value(&self) -> Value {
        Value::Array(self.clone())
    }
}

impl<T: ToValue> ToValue for [T] {
    fn to_value(&self) -> Value {
        Value::Array(self.iter().map(ToValue::to_value).collect())
    }
}

impl<T: ToValue> ToValue for Vec<T> {
    fn to_value(&self) -> Value {
        self.as_slice().to_value()
    }
}

impl<T: ToValue> ToValue for Option<T> {
    fn to_value(&self) -> Value {
        self.as_ref().map_or(Value::Null, ToValue::to_value)
    }
}

macro_rules! numbers {
    ($($t:ty),*) => {$(
        impl ToValue for $t {
            fn to_value(&self) -> Value {
                Value::Number(Number::from(*self))
            }
        }
    )*};
}

numbers!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize, f32, f64);
