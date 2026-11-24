// SPDX-License-Identifier: Apache-2.0
//! The pieces of the column encoders that aren't the table: one column's stored value, the
//! JavaScript comparisons, and the JSON texts the columns print (porting guide 5.3b).

use ace_json::{JsString, Map, Value};
use ace_protocol::shape::Shape;
use ace_protocol::shapes::THREAD_CLIENT_COLUMN;

use super::{Column, ColumnError, ColumnValue, column_value};
use crate::strip::strip_object;

/// A simple column: the field as it is, or NULL for the two columns that coalesce.
pub(super) fn simple(thread: &Map, column: Column) -> Result<ColumnValue, ColumnError> {
    match thread.get(column.field()) {
        None if column.coalesces() => Ok(ColumnValue::Null),
        None => Err(ColumnError::NotStorable(column)),
        Some(Value::Null) => Ok(ColumnValue::Null),
        Some(Value::String(text)) => Ok(ColumnValue::Text(text.clone())),
        Some(Value::Number(number)) => Ok(ColumnValue::Number(number.value())),
        Some(_) => Err(ColumnError::NotStorable(column)),
    }
}

/// The object one shape leaves of the thread, its fields in schema order.
pub(super) fn shaped(thread: &Map, shape: &'static Shape) -> Value {
    match shape {
        Shape::Object(fields) => Value::Object(strip_object(fields, thread)),
        _ => Value::Object(thread.clone()),
    }
}

/// The named thread fields, in the statement's order, absent ones left out.
pub(super) fn picked(thread: &Map, keys: &[&str]) -> Value {
    let mut out = Map::with_capacity(keys.len());
    for key in keys {
        if let Some(value) = thread.get(*key) {
            out.insert(*key, value.clone());
        }
    }
    Value::Object(out)
}

pub(super) fn json_text(value: &Value) -> ColumnValue {
    ColumnValue::Text(JsString::from(ace_json::to_string(value)))
}

/// JavaScript truthiness, as `imported` uses it.
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.value() != 0.0 && !number.value().is_nan(),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Whether two columns of `previous` and `next` are equal by JavaScript `===`.
pub(super) fn columns_equal(previous: &Map, next: &Map, column: Column) -> bool {
    match column {
        Column::Client => client_compare(previous) == client_compare(next),
        Column::Details => details_compare(previous) == details_compare(next),
        Column::Imported => imported_compare(previous) == imported_compare(next),
        Column::Status => present_compare(previous, "status") == present_compare(next, "status"),
        Column::Capabilities => {
            present_compare(previous, "capabilities") == present_compare(next, "capabilities")
        }
        Column::Transitions | Column::ProviderMetadata | Column::Acp => {
            match (column_value(previous, column), column_value(next, column)) {
                (Ok(left), Ok(right)) => left == right,
                _ => false,
            }
        }
        _ => raw_compare(
            previous.get(column.field()),
            next.get(column.field()),
            column.coalesces(),
        ),
    }
}

/// `JSON.stringify(clientKeys.map((key) => thread[key]))`: the shape's keys, null when absent.
fn client_compare(thread: &Map) -> JsString {
    let fields = match &THREAD_CLIENT_COLUMN {
        Shape::Object(fields) => *fields,
        _ => &[],
    };
    let mut items = ace_json::Array::new();
    for field in fields {
        items.push(thread.get(field.key).cloned().unwrap_or(Value::Null));
    }
    JsString::from(ace_json::to_string(&Value::Array(items)))
}

/// `JSON.stringify(details) ?? ""`.
fn details_compare(thread: &Map) -> JsString {
    match thread.get("details") {
        Some(value) => JsString::from(ace_json::to_string(value)),
        None => JsString::default(),
    }
}

/// `JSON.stringify(imported)`, or none where it is falsy.
fn imported_compare(thread: &Map) -> Option<JsString> {
    match thread.get("imported") {
        Some(value) if truthy(value) => Some(JsString::from(ace_json::to_string(value))),
        _ => None,
    }
}

/// `JSON.stringify(field)`: none where the key is absent.
fn present_compare(thread: &Map, field: &str) -> Option<JsString> {
    thread
        .get(field)
        .map(|value| JsString::from(ace_json::to_string(value)))
}

/// JavaScript `===` over one simple field; objects and arrays are never equal (distinct trees
/// here), and kinds never cross.
fn raw_compare(left: Option<&Value>, right: Option<&Value>, coalesce: bool) -> bool {
    match (comparable(left, coalesce), comparable(right, coalesce)) {
        // JavaScript `===` on two objects compares identity, and these are two trees.
        (Comparable::Other, _) | (_, Comparable::Other) => false,
        (left, right) => left == right,
    }
}

#[derive(PartialEq)]
enum Comparable {
    Absent,
    Null,
    Bool(bool),
    Number(f64),
    Text(JsString),
    Other,
}

fn comparable(value: Option<&Value>, coalesce: bool) -> Comparable {
    match value {
        None | Some(Value::Null) if coalesce => Comparable::Null,
        None => Comparable::Absent,
        Some(Value::Null) => Comparable::Null,
        Some(Value::Bool(flag)) => Comparable::Bool(*flag),
        Some(Value::Number(number)) => Comparable::Number(number.value()),
        Some(Value::String(text)) => Comparable::Text(text.clone()),
        Some(Value::Array(_) | Value::Object(_)) => Comparable::Other,
    }
}

/// The JS printing of a number the encoders can hold, for tests and callers that print it.
pub fn print_number(value: f64) -> String {
    let mut out = String::new();
    ace_json::write_number(&mut out, value);
    out
}
