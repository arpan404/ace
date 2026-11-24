// SPDX-License-Identifier: Apache-2.0
//! Zod's parse of a value, minus validation: the shape table says what each object keeps, in
//! which order, and which defaults an absent key gets (porting guide 5.3b). Recursion follows
//! the table, never the value: a [`Shape::Copy`] subtree is cloned by `ace-json` in one
//! non-recursive pass, so the depth is the table's whatever the input.
//!
//! [`conform`] is the part of validation the table does hold: the containers, the required
//! keys and a tagged union's discriminator. Leaf checks (a string's length, a number's
//! integrality, an enum's values) are Zod's alone and stay unported until Rust owns the decode.

use std::fmt;

use ace_json::{Map, Value};
use ace_protocol::shape::{Field, Presence, Shape};

/// What Zod's parse would return for `shape` and `value`, with a wrong JSON type copied as it
/// is. The input is never changed.
pub fn strip(shape: &Shape, value: &Value) -> Value {
    match shape {
        Shape::Copy => value.clone(),
        Shape::Object(fields) => match value {
            Value::Object(map) => Value::Object(strip_object(fields, map)),
            _ => value.clone(),
        },
        Shape::Array(inner) => match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| strip(inner, item)).collect())
            }
            _ => value.clone(),
        },
        Shape::Record(inner) => strip_record(inner, value),
        Shape::Nullable(inner) => match value {
            Value::Null => value.clone(),
            _ => strip(inner, value),
        },
        Shape::Tagged { key, options } => strip_tagged(key, options, value),
    }
}

/// The object one [`Shape::Object`] leaves of `map`: its fields in schema order, defaults at
/// their place, every other key dropped. The caller has checked that `map` is an object.
pub fn strip_object(fields: &[Field], map: &Map) -> Map {
    let mut out = Map::with_capacity(fields.len());
    for field in fields {
        match map.get(field.key) {
            Some(value) => {
                out.insert(field.key, strip(&field.shape, value));
            }
            None => {
                if let Presence::Default(text) = field.presence {
                    out.insert(field.key, ace_json::parse(text).unwrap_or(Value::Null));
                }
            }
        }
    }
    out
}

fn strip_record(inner: &Shape, value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let mut out = Map::with_capacity(map.len());
    for (key, item) in map {
        if key.as_str() == "__proto__" {
            continue;
        }
        out.insert(key, strip(inner, item));
    }
    Value::Object(out)
}

fn strip_tagged(key: &str, options: &[(&str, Shape)], value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let Some(tag) = map.get(key) else {
        return value.clone();
    };
    let printed = ace_json::to_string(tag);
    for (literal, shape) in options {
        if printed == *literal {
            return strip(shape, value);
        }
    }
    value.clone()
}

/// Why a value is not what a schema accepts: the structural part of what Zod's parse throws on.
#[derive(Debug, PartialEq)]
pub struct NotConforming {
    /// Where the bad value is, from the root: `workspaceChange.state`, or `linked[2]`.
    pub path: String,
    /// What is wrong with it.
    pub problem: &'static str,
}

impl fmt::Display for NotConforming {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            formatter.write_str(self.problem)
        } else {
            write!(formatter, "{} {}", self.path, self.problem)
        }
    }
}

impl std::error::Error for NotConforming {}

/// Whether Zod's parse of `shape` would accept `value`: objects where the table has objects,
/// arrays where it has arrays, every required key present, and a tagged union carrying one of
/// its tags. A [`Shape::Copy`] leaf accepts anything, and the leaf checks the table can't hold
/// (lengths, patterns, integrality, enum values) are not applied.
pub fn conform(shape: &Shape, value: &Value) -> Result<(), NotConforming> {
    conform_at(shape, value, "")
}

fn conform_at(shape: &Shape, value: &Value, path: &str) -> Result<(), NotConforming> {
    match shape {
        Shape::Copy => Ok(()),
        Shape::Object(fields) => {
            let Value::Object(map) = value else {
                return Err(NotConforming {
                    path: path.to_owned(),
                    problem: "is not an object",
                });
            };
            for field in *fields {
                match map.get(field.key) {
                    Some(field_value) => {
                        conform_at(&field.shape, field_value, &child(path, field.key))?
                    }
                    None if matches!(field.presence, Presence::Required) => {
                        return Err(NotConforming {
                            path: child(path, field.key),
                            problem: "is missing",
                        });
                    }
                    None => {}
                }
            }
            Ok(())
        }
        Shape::Array(inner) => {
            let Value::Array(items) = value else {
                return Err(NotConforming {
                    path: path.to_owned(),
                    problem: "is not an array",
                });
            };
            for (index, item) in items.iter().enumerate() {
                conform_at(inner, item, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        Shape::Record(inner) => {
            let Value::Object(map) = value else {
                return Err(NotConforming {
                    path: path.to_owned(),
                    problem: "is not an object",
                });
            };
            for (key, item) in map {
                conform_at(inner, item, &child(path, key.as_str()))?;
            }
            Ok(())
        }
        Shape::Nullable(inner) => match value {
            Value::Null => Ok(()),
            _ => conform_at(inner, value, path),
        },
        Shape::Tagged { key, options } => {
            let Value::Object(map) = value else {
                return Err(NotConforming {
                    path: path.to_owned(),
                    problem: "is not an object",
                });
            };
            let Some(tag) = map.get(*key) else {
                return Err(NotConforming {
                    path: child(path, key),
                    problem: "is missing",
                });
            };
            let printed = ace_json::to_string(tag);
            match options.iter().find(|(literal, _)| *literal == printed) {
                Some((_, option)) => conform_at(option, value, path),
                None => Err(NotConforming {
                    path: child(path, key),
                    problem: "is not one of the schema's variants",
                }),
            }
        }
    }
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

#[cfg(test)]
mod tests {
    use ace_json::{JsString, Map, Value};
    use ace_protocol::shapes::{THREAD_CLIENT_COLUMN, THREAD_DETAILS};

    use super::conform;

    fn object(pairs: &[(&str, Value)]) -> Value {
        let mut map = Map::new();
        for (key, value) in pairs {
            map.insert(*key, value.clone());
        }
        Value::Object(map)
    }

    fn text(value: &str) -> Value {
        Value::String(JsString::from(value))
    }

    #[test]
    fn a_details_value_the_schema_holds_conforms() {
        let details = object(&[("mode", text("local")), ("ahead", Value::Null)]);
        assert_eq!(conform(&THREAD_DETAILS, &details), Ok(()));
    }

    #[test]
    fn a_missing_required_field_does_not_conform() {
        // `workspaceChange` needs `state` and `at`; a half-written value has neither.
        let details = object(&[("workspaceChange", object(&[("commandId", text("cmd"))]))]);
        let problem = conform(&THREAD_DETAILS, &details).expect_err("a required key is missing");
        assert_eq!(problem.to_string(), "workspaceChange.state is missing");
    }

    #[test]
    fn a_details_value_that_is_not_an_object_does_not_conform() {
        for value in [Value::Null, text("local"), Value::Array(Vec::new().into())] {
            let problem = conform(&THREAD_DETAILS, &value).expect_err("not an object");
            assert_eq!(problem.problem, "is not an object");
        }
    }

    #[test]
    fn a_tag_the_schema_does_not_know_does_not_conform() {
        let client = object(&[(
            "snoozeWake",
            object(&[("on", text("later")), ("until", Value::Number(1.into()))]),
        )]);
        let problem = conform(&THREAD_CLIENT_COLUMN, &client).expect_err("an unknown tag");
        assert_eq!(
            problem.to_string(),
            "snoozeWake.on is not one of the schema's variants"
        );
    }
}
