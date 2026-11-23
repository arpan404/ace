// SPDX-License-Identifier: Apache-2.0
//! Shared helpers for phase 2 long-thread reads.

use crate::{Error as StoreError, Value};

pub use crate::stmt_cache::{Row, all_rows, all_rows_raw, get_row, get_row_raw};

pub const MAX_SAFE: i64 = 9007199254740991;

/// A phase 2 read failure. `Sqlite` keeps the store's error; `Invalid` is a row this
/// build cannot show (an older index row outside the protocol), with the same message
/// the TypeScript loader throws.
#[derive(Debug)]
pub enum LongError {
    Sqlite(StoreError),
    Invalid(String),
}

impl std::fmt::Display for LongError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LongError::Sqlite(error) => write!(f, "{error}"),
            LongError::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for LongError {}

impl From<StoreError> for LongError {
    fn from(error: StoreError) -> Self {
        LongError::Sqlite(error)
    }
}

impl From<serde_json::Error> for LongError {
    fn from(error: serde_json::Error) -> Self {
        LongError::Invalid(error.to_string())
    }
}

pub fn invalid(message: &str) -> LongError {
    LongError::Invalid(message.to_owned())
}

/// JavaScript `string.length`: UTF-16 code units.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn integer_value(value: &Value) -> Result<i64, LongError> {
    match value {
        Value::Integer(n) => Ok(*n),
        Value::Real(n) => {
            if n.fract() == 0.0 && *n >= i64::MIN as f64 && *n <= i64::MAX as f64 {
                Ok(*n as i64)
            } else {
                Err(invalid("invalid index row"))
            }
        }
        _ => Err(invalid("invalid index row")),
    }
}

/// A protocol count: an integer 0..=MAX_SAFE.
pub fn as_count(value: &Value) -> Result<i64, LongError> {
    let n = integer_value(value)?;
    if (0..=MAX_SAFE).contains(&n) {
        Ok(n)
    } else {
        Err(invalid("invalid index row"))
    }
}

/// A turn ordinal: an integer 1..=MAX_SAFE.
pub fn as_ordinal(value: &Value) -> Result<i64, LongError> {
    let n = integer_value(value)?;
    if (1..=MAX_SAFE).contains(&n) {
        Ok(n)
    } else {
        Err(invalid("invalid index row"))
    }
}

/// A timestamp: a nonnegative integer.
pub fn as_timestamp(value: &Value) -> Result<i64, LongError> {
    let n = integer_value(value)?;
    if n >= 0 {
        Ok(n)
    } else {
        Err(invalid("invalid index row"))
    }
}

pub fn as_seq(value: &Value) -> Result<i64, LongError> {
    as_count(value)
}

pub fn as_text(value: &Value) -> Result<&str, LongError> {
    match value {
        Value::Text(text) => Ok(text.as_str()),
        _ => Err(invalid("invalid index row")),
    }
}

pub fn as_id(value: &Value) -> Result<&str, LongError> {
    let text = as_text(value)?;
    if text.is_empty() {
        return Err(invalid("invalid index row"));
    }
    Ok(text)
}

pub fn as_preview(value: &Value) -> Result<&str, LongError> {
    let text = as_text(value)?;
    if js_len(text) > 1024 {
        return Err(invalid("invalid index row"));
    }
    Ok(text)
}

pub fn as_path(value: &Value) -> Result<&str, LongError> {
    let text = as_text(value)?;
    if js_len(text) > 4096 {
        return Err(invalid("invalid index row"));
    }
    Ok(text)
}

pub fn opt_text(value: Option<&Value>) -> Result<Option<String>, LongError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(Value::Text(text)) => Ok(Some(text.clone())),
        Some(_) => Err(invalid("invalid index row")),
    }
}

pub fn opt_count(value: Option<&Value>) -> Result<Option<i64>, LongError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(as_count(value)?)),
    }
}

pub fn row_value<'a>(row: &'a Row, name: &str) -> Result<&'a Value, LongError> {
    row.get(name).ok_or_else(|| invalid("invalid index row"))
}

pub fn row_opt<'a>(row: &'a Row, name: &str) -> Option<&'a Value> {
    row.get(name)
}

/// The UTF-8 bytes of the JSON this response carries, as `Buffer.byteLength` counts them.
pub fn json_bytes(value: &serde_json::Value) -> Result<usize, LongError> {
    let text = serde_json::to_string(value).map_err(|error| invalid(&error.to_string()))?;
    Ok(text.len())
}

pub fn is_tool_kind(kind: &str) -> bool {
    matches!(
        kind,
        "shell"
            | "file.read"
            | "file.edit"
            | "file.write"
            | "file.delete"
            | "file.move"
            | "search"
            | "web.search"
            | "web.fetch"
            | "mcp"
            | "agent.spawn"
            | "agent.message"
            | "todo"
            | "plan"
            | "ask_user"
            | "browser"
            | "image"
            | "notebook"
            | "custom"
    )
}

/// Kept in `Cargo.toml` with its reason: cursor fingerprints.
pub fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let bytes = hasher.finalize();
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 15), 16).unwrap_or('0'));
    }
    out
}

/// Base64url without padding, as `Buffer.toString("base64url")` writes it.
pub fn base64url_encode(text: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(text.as_bytes())
}

pub fn base64url_decode(cursor: &str) -> Result<String, LongError> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor.as_bytes())
        .map_err(|_| invalid("search_invalid_query"))?;
    String::from_utf8(bytes).map_err(|_| invalid("search_invalid_query"))
}
