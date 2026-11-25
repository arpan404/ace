// SPDX-License-Identifier: Apache-2.0
//! Text-append patches (E5.3 step 4): `Append` (`append.ts:5`) and `restoreAppend`
//! (`append.ts:11`).

use ace_json::Value;

/// One text append: the path to the string leaf, the text, and the object a missing parent
/// starts as. Its JSON is `{path, text, seed?}` in that order.
#[derive(Debug, Clone, PartialEq)]
pub struct Append {
    pub path: Vec<PathStep>,
    pub text: String,
    pub seed: Option<Value>,
}

/// One step of an append's path.
#[derive(Debug, Clone, PartialEq)]
pub enum PathStep {
    Key(String),
    Index(u64),
}

impl Append {
    /// Parse one stored patch; a patch that is not `{path, text, seed?}` is refused.
    pub fn parse(value: &Value) -> Result<Append, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "an append must be an object".to_owned())?;
        let path = match object.get("path").and_then(Value::as_array) {
            Some(steps) if !steps.is_empty() => steps
                .iter()
                .map(|step| match step {
                    Value::String(text) => Ok(PathStep::Key(text.as_str().to_owned())),
                    Value::Number(number) => {
                        let index = number.as_u64().filter(|index| *index < 1u64 << 53);
                        match index {
                            Some(index) => Ok(PathStep::Index(index)),
                            None => Err("an append path index must be a nonnegative integer"),
                        }
                    }
                    _ => Err("an append path step must be a string or a number"),
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err("an append needs a nonempty path".to_owned()),
        };
        let text = object
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| "an append needs text".to_owned())?
            .to_owned();
        let seed = object.get("seed").cloned();
        Ok(Append { path, text, seed })
    }

    /// The patch's stored JSON: `{path, text, seed?}`, in that order.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"path\":[");
        for (index, step) in self.path.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            match step {
                PathStep::Key(key) => {
                    let mut text = String::new();
                    text.push_str(&ace_json::to_string(&Value::from(key)));
                    out.push_str(&text);
                }
                PathStep::Index(index) => out.push_str(&index.to_string()),
            }
        }
        out.push_str("],\"text\":");
        let mut text = String::new();
        text.push_str(&ace_json::to_string(&Value::from(self.text.as_str())));
        out.push_str(&text);
        if let Some(seed) = &self.seed {
            out.push_str(",\"seed\":");
            out.push_str(&ace_json::to_string(seed));
        }
        out.push('}');
        out
    }
}

/// Restore one patch on a stored value: descend the path, create missing objects (the seed
/// only at the last object step), fill arrays, and refuse a non-string leaf with
/// `Invalid saved append target`.
pub fn restore_append(input: Value, patch: &Append) -> Result<Value, String> {
    descend(input, &patch.path, patch)
}

fn descend(value: Value, path: &[PathStep], patch: &Append) -> Result<Value, String> {
    let Some((step, rest)) = path.split_first() else {
        return match value {
            Value::Null => Ok(Value::String((String::new() + &patch.text).into())),
            Value::String(text) => {
                let mut text = text.as_str().to_owned();
                text.push_str(&patch.text);
                Ok(Value::String(text.into()))
            }
            _ => Err("Invalid saved append target".to_owned()),
        };
    };
    match step {
        PathStep::Index(index) => {
            let mut array = match value {
                Value::Null => ace_json::Array::new(),
                Value::Array(array) => array,
                _ => return Err("Invalid saved append target".to_owned()),
            };
            let index = *index as usize;
            while array.len() <= index {
                array.push(Value::Null);
            }
            let current = std::mem::replace(&mut array[index], Value::Null);
            let next = descend(current, rest, patch)?;
            array[index] = next;
            Ok(Value::Array(array))
        }
        PathStep::Key(key) => {
            let mut object = match value {
                Value::Null if rest.is_empty() => match &patch.seed {
                    Some(Value::Object(seed)) => seed.clone(),
                    _ => ace_json::Map::new(),
                },
                Value::Null => ace_json::Map::new(),
                Value::Object(object) => object,
                _ => return Err("Invalid saved append target".to_owned()),
            };
            let current = object.shift_remove(key).unwrap_or(Value::Null);
            let next = descend(current, rest, patch)?;
            object.insert(key.as_str().to_owned(), next);
            Ok(Value::Object(object))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Append {
        Append::parse(&ace_json::parse(text).unwrap()).unwrap()
    }

    #[test]
    fn a_restored_patch_fills_arrays_and_creates_the_missing_object() {
        let patch = parse(r#"{"path":["parts",1,"text"],"text":"hi","seed":{"type":"text"}}"#);
        let input = ace_json::parse(r#"{"parts":[{"type":"text","text":"a"}]}"#).unwrap();
        let restored = restore_append(input, &patch).unwrap();
        assert_eq!(
            ace_json::to_string(&restored),
            r#"{"parts":[{"type":"text","text":"a"},{"type":"text","text":"hi"}]}"#
        );
    }

    #[test]
    fn a_non_string_leaf_is_refused() {
        let patch = parse(r#"{"path":["n"],"text":"x"}"#);
        let input = ace_json::parse(r#"{"n":3}"#).unwrap();
        assert_eq!(
            restore_append(input, &patch).unwrap_err(),
            "Invalid saved append target"
        );
    }

    #[test]
    fn a_patch_round_trips_through_its_stored_json() {
        let patch = parse(r#"{"path":["parts",1,"text"],"text":"hé","seed":{"type":"text"}}"#);
        assert_eq!(
            patch.to_json(),
            r#"{"path":["parts",1,"text"],"text":"hé","seed":{"type":"text"}}"#
        );
        assert_eq!(
            Append::parse(&ace_json::parse(&patch.to_json()).unwrap()).unwrap(),
            patch
        );
    }
}
