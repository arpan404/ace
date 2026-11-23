// SPDX-License-Identifier: Apache-2.0
//! Deep clone and drop. The first levels use the call stack, as derived impls do (fast: a
//! map's hash table is copied, not rebuilt); a per-thread depth count stops recursion at
//! [`RECURSE`] container levels, and deeper levels continue on a heap stack. So a tree nested
//! 100,000 deep clones and drops as safely as a flat one.

use std::cell::Cell;

use crate::object::Map;
use crate::string::JsString;
use crate::value::{Array, Value};

/// Container levels handled on the call stack before the heap stack takes over.
const RECURSE: usize = 48;

thread_local! {
    static DEPTH: Cell<usize> = const { Cell::new(0) };
}

/// Run `step` one container level deeper, or `None` once the bound is reached.
fn deeper<T>(step: impl FnOnce() -> T) -> Option<T> {
    let depth = DEPTH.with(Cell::get);
    if depth >= RECURSE {
        return None;
    }
    DEPTH.with(|cell| cell.set(depth + 1));
    let out = step();
    DEPTH.with(|cell| cell.set(depth));
    Some(out)
}

impl Clone for Value {
    fn clone(&self) -> Value {
        match self {
            Value::Null => Value::Null,
            Value::Bool(flag) => Value::Bool(*flag),
            Value::Number(number) => Value::Number(*number),
            Value::String(text) => Value::String(text.clone()),
            Value::Array(items) => Value::Array(items.clone()),
            Value::Object(map) => Value::Object(map.clone()),
        }
    }
}

impl Clone for Array {
    fn clone(&self) -> Array {
        deeper(|| Array(self.0.clone())).unwrap_or_else(|| {
            let stack = vec![Build::Array(
                self.0.iter(),
                Vec::with_capacity(self.0.len()),
            )];
            match run_clone(stack) {
                Value::Array(items) => items,
                _ => Array::new(),
            }
        })
    }
}

impl Clone for Map {
    fn clone(&self) -> Map {
        deeper(|| self.clone_entries()).unwrap_or_else(|| {
            let stack = vec![Build::Object(
                self.iter(),
                Map::with_capacity(self.len()),
                None,
            )];
            match run_clone(stack) {
                Value::Object(map) => map,
                _ => Map::new(),
            }
        })
    }
}

impl Drop for Array {
    fn drop(&mut self) {
        if self.0.is_empty() || deeper(|| self.0.clear()).is_some() {
            return;
        }
        if self.0.iter().any(is_nested) {
            drop_values(std::mem::take(&mut self.0));
        }
    }
}

impl Drop for Map {
    fn drop(&mut self) {
        if self.is_empty() || deeper(|| self.clear_entries()).is_some() {
            return;
        }
        if self.values().any(is_nested) {
            drop_values(self.take_values());
        }
    }
}

/// Whether dropping the value would drop further containers.
fn is_nested(value: &Value) -> bool {
    match value {
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        _ => false,
    }
}

/// Drop values on a heap stack: a container holding containers is emptied onto the stack
/// before it drops; one holding only leaves drops as is, which never recurses.
fn drop_values(mut stack: Vec<Value>) {
    while let Some(value) = stack.pop() {
        match value {
            Value::Array(mut items) if items.iter().any(is_nested) => {
                stack.append(&mut items.0);
            }
            Value::Object(mut map) if map.values().any(is_nested) => {
                stack.extend(map.take_values());
            }
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
        leaf => Some(leaf.clone()),
    }
}

/// Copy the container on top of `stack`, children first, without recursion.
fn run_clone(mut stack: Vec<Build<'_>>) -> Value {
    let mut ready: Option<Value> = None;
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
                Some(Build::Array(_, out)) => Some(Value::Array(Array::from(out))),
                Some(Build::Object(_, out, _)) => Some(Value::Object(out)),
                None => return Value::Null,
            },
        };
    }
}
