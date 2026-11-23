// SPDX-License-Identifier: Apache-2.0
//! Reading and building values: the accessors code ported from serde_json expects, with
//! JavaScript's answers (`as_i64` is `Number.isInteger`, `1.0` included; `as_str` is the text of
//! any string, and [`Value::as_js_str`] the exact string, lone surrogates included).

use crate::number::Number;
use crate::object::Map;
use crate::string::JsString;
use crate::value::{Array, Value};

static NULL: Value = Value::Null;

impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn is_boolean(&self) -> bool {
        matches!(self, Value::Bool(_))
    }

    pub fn is_number(&self) -> bool {
        matches!(self, Value::Number(_))
    }

    pub fn is_string(&self) -> bool {
        matches!(self, Value::String(_))
    }

    pub fn is_array(&self) -> bool {
        matches!(self, Value::Array(_))
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }

    pub fn is_i64(&self) -> bool {
        self.as_i64().is_some()
    }

    pub fn is_u64(&self) -> bool {
        self.as_u64().is_some()
    }

    pub fn is_f64(&self) -> bool {
        matches!(self, Value::Number(n) if n.is_f64())
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<&Number> {
        match self {
            Value::Number(number) => Some(number),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        self.as_number().map(Number::value)
    }

    pub fn as_i64(&self) -> Option<i64> {
        self.as_number().and_then(Number::as_i64)
    }

    pub fn as_u64(&self) -> Option<u64> {
        self.as_number().and_then(Number::as_u64)
    }

    /// A string's text (`typeof value === "string"`); a lone surrogate reads as U+FFFD here,
    /// while the value itself keeps it.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text.as_str()),
            _ => None,
        }
    }

    /// Any string, lone surrogates included.
    pub fn as_js_str(&self) -> Option<&JsString> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Array> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_array_mut(&mut self) -> Option<&mut Array> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Map> {
        match self {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut Map> {
        match self {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }

    /// `value[key]` for an object or `value[index]` for an array; `None` otherwise.
    pub fn get<I: ValueIndex + ?Sized>(&self, index: &I) -> Option<&Value> {
        index.index_into(self)
    }

    pub fn get_mut<I: ValueIndex + ?Sized>(&mut self, index: &I) -> Option<&mut Value> {
        index.index_into_mut(self)
    }

    /// The value, leaving `null` in its place.
    pub fn take(&mut self) -> Value {
        std::mem::take(self)
    }

    /// An RFC 6901 pointer lookup (`/a/0/b`).
    pub fn pointer(&self, pointer: &str) -> Option<&Value> {
        if pointer.is_empty() {
            return Some(self);
        }
        let rest = pointer.strip_prefix('/')?;
        let mut at = self;
        for token in rest.split('/') {
            let token = token.replace("~1", "/").replace("~0", "~");
            at = match at {
                Value::Object(map) => map.get(token.as_str())?,
                Value::Array(items) => {
                    if token.len() > 1 && token.starts_with('0') {
                        return None;
                    }
                    items.get(token.parse::<usize>().ok()?)?
                }
                _ => return None,
            };
        }
        Some(at)
    }

    /// `JSON.stringify(value)`.
    pub fn to_json(&self) -> String {
        crate::write::to_string(self)
    }
}

/// What a [`Value`] can be indexed by: object keys and array positions.
pub trait ValueIndex {
    #[doc(hidden)]
    fn index_into<'v>(&self, value: &'v Value) -> Option<&'v Value>;
    #[doc(hidden)]
    fn index_into_mut<'v>(&self, value: &'v mut Value) -> Option<&'v mut Value>;
}

impl ValueIndex for str {
    fn index_into<'v>(&self, value: &'v Value) -> Option<&'v Value> {
        value.as_object().and_then(|map| map.get(self))
    }
    fn index_into_mut<'v>(&self, value: &'v mut Value) -> Option<&'v mut Value> {
        value.as_object_mut().and_then(|map| map.get_mut(self))
    }
}

impl ValueIndex for String {
    fn index_into<'v>(&self, value: &'v Value) -> Option<&'v Value> {
        self.as_str().index_into(value)
    }
    fn index_into_mut<'v>(&self, value: &'v mut Value) -> Option<&'v mut Value> {
        self.as_str().index_into_mut(value)
    }
}

impl ValueIndex for JsString {
    fn index_into<'v>(&self, value: &'v Value) -> Option<&'v Value> {
        value.as_object().and_then(|map| map.get(self))
    }
    fn index_into_mut<'v>(&self, value: &'v mut Value) -> Option<&'v mut Value> {
        value.as_object_mut().and_then(|map| map.get_mut(self))
    }
}

impl ValueIndex for usize {
    fn index_into<'v>(&self, value: &'v Value) -> Option<&'v Value> {
        value.as_array().and_then(|items| items.get(*self))
    }
    fn index_into_mut<'v>(&self, value: &'v mut Value) -> Option<&'v mut Value> {
        value.as_array_mut().and_then(|items| items.get_mut(*self))
    }
}

impl<T: ValueIndex + ?Sized> ValueIndex for &T {
    fn index_into<'v>(&self, value: &'v Value) -> Option<&'v Value> {
        (**self).index_into(value)
    }
    fn index_into_mut<'v>(&self, value: &'v mut Value) -> Option<&'v mut Value> {
        (**self).index_into_mut(value)
    }
}

impl<I: ValueIndex> std::ops::Index<I> for Value {
    type Output = Value;
    /// `value[key]`, with `null` standing in for a missing key (JavaScript's `undefined`).
    fn index(&self, index: I) -> &Value {
        index.index_into(self).unwrap_or(&NULL)
    }
}

impl std::ops::Index<&str> for Map {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&NULL)
    }
}

impl From<bool> for Value {
    fn from(flag: bool) -> Value {
        Value::Bool(flag)
    }
}

impl From<Number> for Value {
    fn from(number: Number) -> Value {
        Value::Number(number)
    }
}

macro_rules! from_number {
    ($($t:ty),*) => {$(
        impl From<$t> for Value {
            fn from(value: $t) -> Value {
                Value::Number(Number::from(value))
            }
        }
    )*};
}

from_number!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize, f32, f64);

impl From<String> for Value {
    fn from(text: String) -> Value {
        Value::String(JsString::from(text))
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Value {
        Value::String(JsString::from(text))
    }
}

impl From<&String> for Value {
    fn from(text: &String) -> Value {
        Value::String(JsString::from(text))
    }
}

impl From<JsString> for Value {
    fn from(text: JsString) -> Value {
        Value::String(text)
    }
}

impl From<&JsString> for Value {
    fn from(text: &JsString) -> Value {
        Value::String(text.clone())
    }
}

impl From<std::borrow::Cow<'_, str>> for Value {
    fn from(text: std::borrow::Cow<'_, str>) -> Value {
        Value::String(JsString::from(text))
    }
}

impl From<Vec<Value>> for Value {
    fn from(items: Vec<Value>) -> Value {
        Value::Array(Array::from(items))
    }
}

impl From<Array> for Value {
    fn from(items: Array) -> Value {
        Value::Array(items)
    }
}

impl From<Map> for Value {
    fn from(map: Map) -> Value {
        Value::Object(map)
    }
}

impl From<&Value> for Value {
    fn from(value: &Value) -> Value {
        value.clone()
    }
}

impl From<()> for Value {
    fn from((): ()) -> Value {
        Value::Null
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(value: Option<T>) -> Value {
        value.map_or(Value::Null, Into::into)
    }
}

impl FromIterator<Value> for Value {
    fn from_iter<I: IntoIterator<Item = Value>>(iter: I) -> Value {
        Value::Array(iter.into_iter().collect())
    }
}

impl PartialEq<str> for Value {
    fn eq(&self, other: &str) -> bool {
        self.as_js_str().is_some_and(|text| text == other)
    }
}

impl PartialEq<&str> for Value {
    fn eq(&self, other: &&str) -> bool {
        self.as_js_str().is_some_and(|text| text == other)
    }
}

impl PartialEq<bool> for Value {
    fn eq(&self, other: &bool) -> bool {
        self.as_bool() == Some(*other)
    }
}
