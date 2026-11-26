// SPDX-License-Identifier: Apache-2.0
//! Interpret the schema generated from Zod, preserving the order of parsed fields.

use std::collections::HashMap;

use ace_json::{JsString, Map, Value};
use serde::Deserialize;

use super::checks::Check;

#[derive(Deserialize)]
pub(super) struct Schema {
    #[serde(flatten)]
    shape: Shape,
    #[serde(default)]
    checks: Vec<Check>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Shape {
    String,
    Number,
    Boolean,
    Null,
    Unknown,
    Literal {
        values: Vec<Value>,
    },
    Array {
        inner: Box<Schema>,
    },
    Object {
        strict: bool,
        fields: Vec<(String, Schema)>,
    },
    Record {
        keys: Box<Schema>,
        entries: Box<Schema>,
    },
    Optional {
        inner: Box<Schema>,
    },
    Nullable {
        inner: Box<Schema>,
    },
    Default {
        inner: Box<Schema>,
        value: Value,
    },
    Union {
        options: Vec<Schema>,
    },
    Tagged {
        discriminator: String,
        variants: HashMap<JsString, Schema>,
    },
    Intersection {
        left: Box<Schema>,
        right: Box<Schema>,
    },
}

type Parsed = Result<Option<Value>, ()>;

impl Schema {
    pub(super) fn parse(&self, input: &Value) -> Option<Value> {
        self.read(Some(input)).ok().flatten()
    }

    fn read(&self, input: Option<&Value>) -> Parsed {
        let out = self.read_shape(input)?;
        if let Some(value) = &out
            && self.checks.iter().any(|check| !check.accepts(value))
        {
            return Err(());
        }
        Ok(out)
    }

    fn read_shape(&self, input: Option<&Value>) -> Parsed {
        match (&self.shape, input) {
            (Shape::Optional { inner }, None) => match inner.shape {
                Shape::Default { .. } => inner.read(None),
                _ => Ok(None),
            },
            (Shape::Default { value, .. }, None) => Ok(Some(value.clone())),
            (Shape::Optional { inner } | Shape::Default { inner, .. }, Some(value)) => {
                inner.read(Some(value))
            }
            (Shape::Nullable { .. }, Some(Value::Null)) => Ok(Some(Value::Null)),
            (Shape::Nullable { inner }, Some(value)) => inner.read(Some(value)),
            (_, Some(value)) => self.read_present(value).map(Some),
            (_, None) => Err(()),
        }
    }

    fn read_present(&self, value: &Value) -> Result<Value, ()> {
        match (&self.shape, value) {
            (Shape::String, Value::String(_))
            | (Shape::Boolean, Value::Bool(_))
            | (Shape::Null, Value::Null)
            | (Shape::Unknown, _) => Ok(value.clone()),
            (Shape::Number, Value::Number(_)) if value.as_f64().is_some_and(f64::is_finite) => {
                Ok(value.clone())
            }
            (Shape::Literal { values }, _) if values.contains(value) => Ok(value.clone()),
            (Shape::Array { inner }, Value::Array(items)) => items
                .iter()
                .map(|item| inner.parse(item).ok_or(()))
                .collect::<Result<Vec<_>, _>>()
                .map(|items| Value::Array(items.into())),
            (Shape::Object { strict, fields }, Value::Object(input)) => {
                read_object(input, *strict, fields).map(Value::Object)
            }
            (Shape::Record { keys, entries }, Value::Object(input)) => {
                read_record(input, keys, entries).map(Value::Object)
            }
            (
                Shape::Tagged {
                    discriminator,
                    variants,
                },
                _,
            ) => {
                let Some(Value::String(tag)) = value.get(discriminator.as_str()) else {
                    return Err(());
                };
                variants.get(tag).and_then(|arm| arm.parse(value)).ok_or(())
            }
            (Shape::Union { options }, _) => options
                .iter()
                .find_map(|option| option.parse(value))
                .ok_or(()),
            (Shape::Intersection { left, right }, Value::Object(input)) => {
                // The generated intersection is a record refined by a fixed object. The
                // record accepts the object's extra keys, so no key is rejected by both.
                let Some(Value::Object(mut out)) = left.parse(value) else {
                    return Err(());
                };
                let Shape::Object { fields, .. } = &right.shape else {
                    return Err(());
                };
                for (key, value) in read_object(input, false, fields)? {
                    out.insert(key, value);
                }
                Ok(Value::Object(out))
            }
            _ => Err(()),
        }
    }
}

fn read_object(input: &Map, strict: bool, fields: &[(String, Schema)]) -> Result<Map, ()> {
    if strict
        && input
            .keys()
            .any(|key| !fields.iter().any(|(field, _)| key == field))
    {
        return Err(());
    }
    let mut out = Map::new();
    for (key, schema) in fields {
        if let Some(value) = schema.read(input.get(key.as_str()))? {
            out.insert(key.as_str(), value);
        }
    }
    Ok(out)
}

fn read_record(input: &Map, keys: &Schema, entries: &Schema) -> Result<Map, ()> {
    let mut out = Map::new();
    for (key, value) in input {
        if key != "__proto__" {
            keys.parse(&Value::String(key.clone())).ok_or(())?;
            out.insert(key.clone(), entries.parse(value).ok_or(())?);
        }
    }
    Ok(out)
}
