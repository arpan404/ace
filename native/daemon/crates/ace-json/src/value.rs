// SPDX-License-Identifier: Apache-2.0
//! The value tree `JSON.parse` returns. Drop, clone and equality walk it with a heap stack,
//! never the call stack, so a tree nested 100,000 deep is as safe as a flat one.

use std::ops::{Deref, DerefMut};

use crate::number::Number;
use crate::object::Map;
use crate::string::JsString;

/// A JSON value with JavaScript's semantics (see the crate docs).
#[derive(Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(Number),
    String(JsString),
    Array(Array),
    Object(Map),
}

/// An array's items. A newtype over `Vec<Value>` (it derefs to one) only so dropping a deep
/// array is iterative.
#[derive(Default)]
pub struct Array(Vec<Value>);

impl Array {
    pub fn new() -> Array {
        Array(Vec::new())
    }

    pub fn with_capacity(capacity: usize) -> Array {
        Array(Vec::with_capacity(capacity))
    }

    pub fn into_vec(mut self) -> Vec<Value> {
        std::mem::take(&mut self.0)
    }
}

impl Deref for Array {
    type Target = Vec<Value>;
    fn deref(&self) -> &Vec<Value> {
        &self.0
    }
}

impl DerefMut for Array {
    fn deref_mut(&mut self) -> &mut Vec<Value> {
        &mut self.0
    }
}

impl From<Vec<Value>> for Array {
    fn from(items: Vec<Value>) -> Array {
        Array(items)
    }
}

impl FromIterator<Value> for Array {
    fn from_iter<I: IntoIterator<Item = Value>>(iter: I) -> Array {
        Array(iter.into_iter().collect())
    }
}

impl IntoIterator for Array {
    type Item = Value;
    type IntoIter = std::vec::IntoIter<Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.into_vec().into_iter()
    }
}

impl<'a> IntoIterator for &'a Array {
    type Item = &'a Value;
    type IntoIter = std::slice::Iter<'a, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl<'a> IntoIterator for &'a mut Array {
    type Item = &'a mut Value;
    type IntoIter = std::slice::IterMut<'a, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter_mut()
    }
}

impl Drop for Array {
    fn drop(&mut self) {
        if !self.0.is_empty() {
            drop_values(std::mem::take(&mut self.0));
        }
    }
}

/// Drop values with a heap stack: each container is emptied before it is dropped.
pub(crate) fn drop_values(mut stack: Vec<Value>) {
    while let Some(value) = stack.pop() {
        match value {
            Value::Array(mut items) => stack.append(&mut items.0),
            Value::Object(mut map) => stack.extend(map.take_values()),
            _ => {}
        }
    }
}

/// One container being copied: the source's remaining children and the copy so far.
enum Build<'a> {
    Array(std::slice::Iter<'a, Value>, Vec<Value>),
    Object(
        indexmap::map::Iter<'a, JsString, Value>,
        Map,
        Option<JsString>,
    ),
}

/// A leaf's copy, or `None` after pushing the container's frame.
fn open<'a>(value: &'a Value, stack: &mut Vec<Build<'a>>) -> Option<Value> {
    match value {
        Value::Null => Some(Value::Null),
        Value::Bool(flag) => Some(Value::Bool(*flag)),
        Value::Number(number) => Some(Value::Number(*number)),
        Value::String(text) => Some(Value::String(text.clone())),
        Value::Array(items) => {
            stack.push(Build::Array(items.iter(), Vec::with_capacity(items.len())));
            None
        }
        Value::Object(map) => {
            stack.push(Build::Object(
                map.iter(),
                Map::with_capacity(map.len()),
                None,
            ));
            None
        }
    }
}

fn run_clone(mut stack: Vec<Build<'_>>, mut ready: Option<Value>) -> Value {
    loop {
        if let Some(value) = ready.take() {
            match stack.last_mut() {
                None => return value,
                Some(Build::Array(_, out)) => out.push(value),
                Some(Build::Object(_, out, key)) => {
                    if let Some(key) = key.take() {
                        out.push_ordered(key, value);
                    }
                }
            }
        }
        let child = match stack.last_mut() {
            None => return Value::Null,
            Some(Build::Array(iter, _)) => iter.next(),
            Some(Build::Object(iter, _, key)) => iter.next().map(|(name, child)| {
                *key = Some(name.clone());
                child
            }),
        };
        ready = match child {
            Some(child) => open(child, &mut stack),
            None => match stack.pop() {
                Some(Build::Array(_, out)) => Some(Value::Array(Array(out))),
                Some(Build::Object(_, out, _)) => Some(Value::Object(out)),
                None => return Value::Null,
            },
        };
    }
}

/// A deep copy without recursion.
pub(crate) fn clone_deep(value: &Value) -> Value {
    let mut stack = Vec::new();
    let ready = open(value, &mut stack);
    run_clone(stack, ready)
}

pub(crate) fn clone_map(map: &Map) -> Map {
    let stack = vec![Build::Object(
        map.iter(),
        Map::with_capacity(map.len()),
        None,
    )];
    match run_clone(stack, None) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl Clone for Value {
    fn clone(&self) -> Value {
        clone_deep(self)
    }
}

impl Clone for Array {
    fn clone(&self) -> Array {
        let stack = vec![Build::Array(
            self.0.iter(),
            Vec::with_capacity(self.0.len()),
        )];
        match run_clone(stack, None) {
            Value::Array(items) => items,
            _ => Array::new(),
        }
    }
}

/// Deep equality without recursion: numbers by `===`, objects regardless of key order.
fn equal_pairs<'a>(mut stack: Vec<(&'a Value, &'a Value)>) -> bool {
    while let Some(pair) = stack.pop() {
        match pair {
            (Value::Null, Value::Null) => {}
            (Value::Bool(a), Value::Bool(b)) if a == b => {}
            (Value::Number(a), Value::Number(b)) if a == b => {}
            (Value::String(a), Value::String(b)) if a == b => {}
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                stack.extend(a.iter().zip(b.iter()));
            }
            (Value::Object(a), Value::Object(b)) if a.len() == b.len() => {
                for (key, value) in a {
                    match b.get(key) {
                        Some(other) => stack.push((value, other)),
                        None => return false,
                    }
                }
            }
            _ => return false,
        }
    }
    true
}

pub(crate) fn maps_equal(a: &Map, b: &Map) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut stack = Vec::with_capacity(a.len());
    for (key, value) in a {
        match b.get(key) {
            Some(other) => stack.push((value, other)),
            None => return false,
        }
    }
    equal_pairs(stack)
}

impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        equal_pairs(vec![(self, other)])
    }
}

impl PartialEq for Array {
    fn eq(&self, other: &Array) -> bool {
        self.0.len() == other.0.len() && equal_pairs(self.0.iter().zip(other.0.iter()).collect())
    }
}

impl std::fmt::Debug for Value {
    /// The value's JSON text.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::write::to_string(self))
    }
}

impl std::fmt::Debug for Array {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut out = String::new();
        crate::write::write_items(&mut out, &self.0);
        f.write_str(&out)
    }
}

impl std::fmt::Display for Value {
    /// `JSON.stringify(value)`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::write::to_string(self))
    }
}
