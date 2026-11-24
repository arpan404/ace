#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! The column vectors: `columns.json` holds exactly what the TypeScript encoders produce and
//! what SQLite's binder accepts (porting guide 5.3b).

use ace_json::{Map, Value};
use ace_projection::{
    Column, ColumnError, ColumnValue, cold_row_values, column_changes, column_value, print_number,
};

#[test]
fn column_vectors_match_typescript() {
    let path = env!("CARGO_MANIFEST_DIR").to_owned() + "/../../vectors/columns.json";
    let text = std::fs::read_to_string(&path).expect("read columns.json");
    let parsed = ace_json::parse(&text).expect("parse columns.json");
    let cases = parsed.as_array().expect("columns.json holds an array");
    assert!(!cases.is_empty(), "columns.json holds cases");
    for case in cases {
        check_case(case);
    }
}

fn check_case(case: &Value) {
    let name = text(field(case, "name"));
    let previous = match field(case, "previous") {
        Value::Null => None,
        value => Some(parse(text(value))),
    };
    let next = parse(text(field(case, "next")));
    let wanted: Vec<Column> = field(case, "wanted")
        .as_array()
        .expect("wanted is an array")
        .iter()
        .map(|name| Column::from_name(text(name)).expect("a known column"))
        .collect();
    check_values(case, &next, name);
    check_changes(case, previous.as_ref(), &next, &wanted, name);
}

fn check_values(case: &Value, next: &Map, name: &str) {
    let values = field(case, "values")
        .as_array()
        .expect("values is an array");
    assert_eq!(values.len(), Column::ALL.len(), "{name}: every column");
    for (index, entry) in values.iter().enumerate() {
        let pair = entry.as_array().expect("a column and its value");
        let column = Column::from_name(text(&pair[0])).expect("a known column");
        assert_eq!(column, Column::ALL[index], "{name}: table order");
        let actual = column_value(next, column);
        expect_value(actual, pair[1].clone(), column, name);
    }
}

fn check_changes(case: &Value, previous: Option<&Map>, next: &Map, wanted: &[Column], name: &str) {
    let recorded = field(case, "changes");
    if recorded.is_null() {
        // The TypeScript threw (a ZodError); Rust returns whatever it shaped, without panicking.
        let _ = column_changes(previous, next, wanted);
        return;
    }
    let changes =
        column_changes(previous, next, wanted).unwrap_or_else(|error| panic!("{name}: {error}"));
    check_list(&changes.row, field(recorded, "row"), name);
    check_list(&changes.hot, field(recorded, "hot"), name);
    check_list(&changes.cold, field(recorded, "cold"), name);
    let parts: Vec<&str> = changes.parts.iter().map(|part| part.name()).collect();
    let expected: Vec<&str> = field(recorded, "parts")
        .as_array()
        .expect("parts is an array")
        .iter()
        .map(text)
        .collect();
    assert_eq!(parts, expected, "{name}: parts");
    let cold_row = field(recorded, "coldRow");
    if cold_row.is_null() {
        assert!(
            changes.cold.is_empty(),
            "{name}: no cold row without a cold change"
        );
        return;
    }
    let values =
        cold_row_values(previous, &changes).unwrap_or_else(|error| panic!("{name}: {error}"));
    let expected = cold_row.as_array().expect("coldRow is an array");
    assert_eq!(
        expected.len(),
        2,
        "{name}: coldRow holds details and capabilities"
    );
    for (index, value) in values.into_iter().enumerate() {
        expect_value(
            Ok(value),
            expected[index].clone(),
            if index == 0 {
                Column::Details
            } else {
                Column::Capabilities
            },
            name,
        );
    }
}

fn check_list(actual: &[(Column, ColumnValue)], recorded: &Value, name: &str) {
    let items = recorded.as_array().expect("a list");
    assert_eq!(actual.len(), items.len(), "{name}: list length");
    for (index, item) in items.iter().enumerate() {
        let pair = item.as_array().expect("a column and its value");
        let column = Column::from_name(text(&pair[0])).expect("a known column");
        let (actual_column, actual_value) = &actual[index];
        assert_eq!(*actual_column, column, "{name}: column order");
        expect_value(Ok(actual_value.clone()), pair[1].clone(), column, name);
    }
}

fn expect_value(
    actual: Result<ColumnValue, ColumnError>,
    recorded: Value,
    column: Column,
    name: &str,
) {
    let record = recorded.as_array().expect("a value record");
    let kind = text(&record[0]);
    match kind {
        "text" => {
            let expected = record[1].as_js_str().expect("a text value");
            match actual {
                Ok(ColumnValue::Text(actual)) => {
                    assert_eq!(&actual, expected, "{name}: {} text", column.name());
                }
                other => panic!("{name}: {} expected text, got {other:?}", column.name()),
            }
        }
        "number" => {
            let expected = text(&record[1]);
            match actual {
                Ok(ColumnValue::Number(value)) => {
                    assert_eq!(
                        print_number(value),
                        expected,
                        "{name}: {} number",
                        column.name()
                    );
                }
                other => panic!("{name}: {} expected number, got {other:?}", column.name()),
            }
        }
        "null" => assert!(
            matches!(actual, Ok(ColumnValue::Null)),
            "{name}: {} expected null, got {actual:?}",
            column.name()
        ),
        "unstorable" => assert!(
            matches!(actual, Err(ColumnError::NotStorable(stored)) if stored == column),
            "{name}: {} expected unstorable, got {actual:?}",
            column.name()
        ),
        "rejected" => {
            // Zod rejects this in TypeScript; Rust shapes what it can without panicking.
            let _ = actual;
        }
        other => panic!("{name}: unknown value kind {other}"),
    }
}

fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
    value
        .as_object()
        .expect("an object")
        .get(name)
        .unwrap_or_else(|| panic!("a field named {name}"))
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn parse(text: &str) -> Map {
    match ace_json::parse(text).expect("parse vector JSON") {
        Value::Object(map) => map,
        _ => panic!("a vector is an object"),
    }
}
