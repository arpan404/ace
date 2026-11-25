// SPDX-License-Identifier: Apache-2.0
//! `boundedJson` (`provider-kit/src/ipc.ts:4`–`:58`) as a walk over a value that was already
//! parsed: the admission check that runs before anything the host wrote can become a frame.
//!
//! The order is the TypeScript's, branch for branch: the node and depth budget first, then each
//! value's own check, and a string's or a key's **UTF-16 length** against the remaining **UTF-8**
//! byte budget (ipc.ts:18, `:50`, porting-guide rule 17). Appending checks the UTF-8 bytes it
//! actually wrote, so an astral character can pass the pre-check and still end the walk on
//! "SDK payload exceeds byte budget". Every message here is `ipc.ts`'s.
//!
//! Three branches the TypeScript has cannot be reached through `JSON.parse`: a getter on an
//! accessor pair, a cyclic tree, and an object that was not a plain `Object.prototype` one
//! (`NoJson`, `Cyclic` and `NonObject`). A parsed value is a finite tree of plain containers, so
//! this port stops where parsing guarantees those branches away.

use ace_json::{JsString, Value, write_js_string, write_number};

/// `boundedJson`'s default budget (`ipc.ts:4`): one MiB.
pub const DEFAULT_MAX_BYTES: usize = 1_048_576;
/// The structure budget: nodes visited and depth (`ipc.ts:15`, `:44`).
const MAX_NODES: usize = 32_768;
const MAX_DEPTH: u64 = 64;

/// A bound the payload broke, in the TypeScript's own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BoundedError {
    /// `++nodes > 32768 || depth > 64` (`ipc.ts:15`).
    #[error("SDK payload exceeds structure budget")]
    Structure,
    /// `append` after the budget was spent (`ipc.ts:10`).
    #[error("SDK payload exceeds byte budget")]
    Bytes,
    /// A string longer (in UTF-16) than what is left of the byte budget (`ipc.ts:18`).
    #[error("SDK string exceeds byte budget")]
    String,
    /// An array longer than the nodes left (`ipc.ts:23`).
    #[error("SDK array exceeds budget")]
    Array,
    /// An object with more keys than the nodes left (`ipc.ts:44`).
    #[error("SDK object exceeds budget")]
    Object,
    /// A key longer (in UTF-16) than what is left of the byte budget (`ipc.ts:50`).
    #[error("SDK key exceeds budget")]
    Key,
    /// `typeof input !== "object"`: only a non-finite number survives parsing (`ipc.ts:21`).
    #[error("Non-JSON SDK payload")]
    NotJson,
}

/// `boundedJson(value, maxBytes)`: the canonical text, or the first bound that broke.
pub fn bounded_json(value: &Value, max_bytes: usize) -> Result<String, BoundedError> {
    let mut walk = Walk {
        max: max_bytes,
        bytes: 0,
        nodes: 0,
        out: Some(String::new()),
        scratch: String::new(),
    };
    walk.visit(value, 0)?;
    Ok(walk.out.take().unwrap_or_default())
}

/// The same walk without keeping the text: the check a frame takes when its text is borrowed
/// from the line verbatim.
pub fn bounded_check(value: &Value, max_bytes: usize) -> Result<(), BoundedError> {
    let mut walk = Walk {
        max: max_bytes,
        bytes: 0,
        nodes: 0,
        out: None,
        scratch: String::new(),
    };
    walk.visit(value, 0)
}

struct Walk {
    max: usize,
    bytes: usize,
    nodes: usize,
    /// `None` counts only.
    out: Option<String>,
    /// Reused for a string's or a number's encoded text, so a count allocates nothing per value.
    scratch: String,
}

impl Walk {
    /// What is left of the budget. `append` never lets `bytes` pass `max`, so this can't wrap.
    fn room(&self) -> usize {
        self.max.saturating_sub(self.bytes)
    }

    fn append(&mut self, text: &str) -> Result<(), BoundedError> {
        self.bytes += text.len();
        if self.bytes > self.max {
            return Err(BoundedError::Bytes);
        }
        if let Some(out) = &mut self.out {
            out.push_str(text);
        }
        Ok(())
    }

    fn append_string(&mut self, text: &JsString) -> Result<(), BoundedError> {
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.clear();
        write_js_string(&mut scratch, text);
        let result = self.append(&scratch);
        self.scratch = scratch;
        result
    }

    fn append_number(&mut self, value: f64) -> Result<(), BoundedError> {
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.clear();
        write_number(&mut scratch, value);
        let result = self.append(&scratch);
        self.scratch = scratch;
        result
    }

    /// `visit(input, depth)` (`ipc.ts:14`–`:56`).
    fn visit(&mut self, value: &Value, depth: u64) -> Result<(), BoundedError> {
        self.nodes += 1;
        if self.nodes > MAX_NODES || depth > MAX_DEPTH {
            return Err(BoundedError::Structure);
        }
        match value {
            Value::Null => self.append("null"),
            Value::Bool(true) => self.append("true"),
            Value::Bool(false) => self.append("false"),
            Value::Number(number) => {
                // `typeof input === "number" && Number.isFinite(input)`; anything else is not
                // JSON to the TypeScript, so a parsed `1e999` is refused here.
                let value = number.value();
                if !value.is_finite() {
                    return Err(BoundedError::NotJson);
                }
                self.append_number(value)
            }
            Value::String(text) => {
                if text.len_utf16() > self.room() {
                    return Err(BoundedError::String);
                }
                self.append_string(text)
            }
            Value::Array(items) => {
                if items.len() > MAX_NODES - self.nodes {
                    return Err(BoundedError::Array);
                }
                self.append("[")?;
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        self.append(",")?;
                    }
                    self.visit(item, depth + 1)?;
                }
                self.append("]")
            }
            Value::Object(map) => {
                self.append("{")?;
                let mut first = true;
                for (key, item) in map.iter() {
                    self.nodes += 1;
                    if self.nodes > MAX_NODES {
                        return Err(BoundedError::Object);
                    }
                    if !first {
                        self.append(",")?;
                    }
                    first = false;
                    if key.len_utf16() > self.room() {
                        return Err(BoundedError::Key);
                    }
                    self.append_string(key)?;
                    self.append(":")?;
                    self.visit(item, depth + 1)?;
                }
                self.append("}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BoundedError, bounded_check, bounded_json};

    fn text(json: &str, max: usize) -> Result<String, BoundedError> {
        bounded_json(&ace_json::parse(json).expect("valid JSON"), max)
    }

    #[test]
    fn a_payload_under_its_budget_is_its_own_stringified_text() {
        assert_eq!(
            text(r#"{"a":[1,true,null,"x"]}"#, 1024),
            Ok(r#"{"a":[1,true,null,"x"]}"#.into())
        );
        assert_eq!(text("[]", 2), Ok("[]".into()));
        assert_eq!(text("{}", 2), Ok("{}".into()));
        assert_eq!(text("null", 4), Ok("null".into()));
    }

    #[test]
    fn a_byte_over_the_budget_ends_the_walk() {
        assert_eq!(text("[1]", 2), Err(BoundedError::Bytes));
        assert_eq!(text("[1]", 3), Ok("[1]".into()));
    }

    #[test]
    fn a_string_is_measured_in_utf16_before_its_escaped_bytes_are_spent() {
        // "😀" is two UTF-16 units and six escaped UTF-8 bytes with its quotes.
        assert_eq!(text(r#""😀""#, 6), Ok(r#""😀""#.into()));
        assert_eq!(text(r#""😀""#, 5), Err(BoundedError::Bytes));
        // Two emoji fit a budget their own length leaves, and fail the escaped one.
        assert_eq!(text(r#""😀😀""#, 8), Err(BoundedError::Bytes));
        // A lone surrogate is one unit and six escaped bytes, as `JSON.stringify` writes it.
        assert_eq!(text(r#""\ud800""#, 7), Err(BoundedError::Bytes));
        assert_eq!(text(r#""\ud800""#, 8), Ok(r#""\ud800""#.into()));
    }

    #[test]
    fn a_string_longer_than_the_room_left_is_a_string_error_not_a_byte_one() {
        // Five units against one byte left: the pre-check fires before the escaped bytes.
        assert_eq!(text(r#"{"a":"hello"}"#, 8), Err(BoundedError::String));
        assert_eq!(text(r#"{"a":"hello"}"#, 13), Ok(r#"{"a":"hello"}"#.into()));
    }

    #[test]
    fn a_key_longer_than_the_room_left_is_a_key_error() {
        assert_eq!(text(r#"{"abc":1}"#, 3), Err(BoundedError::Key));
        assert_eq!(text(r#"{"abc":1}"#, 9), Ok(r#"{"abc":1}"#.into()));
    }

    #[test]
    fn the_node_budget_counts_the_container_itself() {
        // One array node plus 32,767 leaves is the budget exactly.
        let under = format!("[{}]", vec!["null"; 32_767].join(","));
        assert!(text(&under, 1024 * 1024).is_ok());
        // One more leaf leaves no room for the array's own items.
        let over = format!("[{}]", vec!["null"; 32_768].join(","));
        assert_eq!(text(&over, 1024 * 1024), Err(BoundedError::Array));
        // A flat object counts its container, every key and every value; a parsed tree always
        // visits the last value, so its structure budget fires before the key's own bound.
        let keys: Vec<String> = (0..16_384)
            .map(|index| format!(r#""k{index}":null"#))
            .collect();
        let over = format!("{{{}}}", keys.join(","));
        assert_eq!(text(&over, 1024 * 1024), Err(BoundedError::Structure));
    }

    #[test]
    fn the_depth_budget_stops_one_level_past_its_limit() {
        let at = |levels: usize| {
            let mut json = String::from("null");
            for _ in 0..levels {
                json = format!("[{json}]");
            }
            text(&json, 1024 * 1024)
        };
        // The innermost leaf sits at depth 64 after 64 brackets, and one more is refused.
        assert!(at(64).is_ok());
        assert_eq!(at(65), Err(BoundedError::Structure));
    }

    #[test]
    fn a_non_finite_number_is_not_json_to_the_walk() {
        // `JSON.parse("1e999")` is `Infinity`, and `boundedJson` refuses it (`ipc.ts:21`).
        assert_eq!(text("1e999", 1024), Err(BoundedError::NotJson));
        assert_eq!(text("[1e999]", 1024), Err(BoundedError::NotJson));
    }

    #[test]
    fn the_check_walk_refuses_what_the_text_walk_refuses() {
        let value = ace_json::parse(r#"{"a":["😀",1]}"#).expect("valid JSON");
        for max in [0, 3, 8, 12, 16, 17, 64] {
            assert_eq!(
                bounded_check(&value, max).is_err(),
                bounded_json(&value, max).is_err(),
                "budget {max}"
            );
        }
        assert_eq!(bounded_check(&value, 64), Ok(()));
    }
}
