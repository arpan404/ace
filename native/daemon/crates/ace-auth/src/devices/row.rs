// SPDX-License-Identifier: Apache-2.0
//! A `devices` row decoded, and the SQL values it is written with (`devices.ts:83`-`:93`): the
//! same columns, the same JSON cell, and the generation derived from the stored hash.

use ace_store::Value;
use sha2::{Digest, Sha256};

use crate::devices::{Device, Scope};
use crate::error::{AuthError, Result};

pub(crate) const COLUMNS: &str = "id, name, token_hash, scopes, created_at, last_seen_at, revoked_at, \
                       expires_at, install_id, merged_into, person, standing_key, account_link";

/// One decoded row.
#[derive(Debug, Clone)]
pub(crate) struct Row {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) token_hash: String,
    pub(crate) scopes: Vec<Scope>,
    pub(crate) created_at: i64,
    pub(crate) last_seen_at: i64,
    pub(crate) revoked_at: Option<i64>,
    pub(crate) expires_at: Option<i64>,
    pub(crate) install_id: Option<String>,
    pub(crate) merged_into: Option<String>,
    pub(crate) person: bool,
    pub(crate) standing_key: Option<String>,
    pub(crate) account_link: Option<String>,
}

/// The generation a credential's stored hash names: the first 32 hex characters of
/// `sha256("generation:" + token_hash)` (`devices.ts:80`).
pub(crate) fn generation_of(token_hash: &str) -> String {
    let digest = hex::encode(Sha256::digest(
        format!("generation:{token_hash}").as_bytes(),
    ));
    digest[..32].to_owned()
}

impl Row {
    pub(crate) fn device(&self) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            scopes: self.scopes.clone(),
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            revoked_at: self.revoked_at,
            expires_at: self.expires_at,
        }
    }

    pub(crate) fn generation(&self) -> String {
        generation_of(&self.token_hash)
    }
}

/// A listener told a device was revoked or its scopes changed.
pub(crate) fn decode(values: &[Value]) -> Result<Row> {
    let field = |index: usize| -> Value { values.get(index).cloned().unwrap_or(Value::Null) };
    let string = |index: usize| -> String {
        match field(index) {
            Value::Text(text) => text,
            Value::Integer(number) => number.to_string(),
            Value::Null | Value::Real(_) | Value::Blob(_) => String::new(),
        }
    };
    let optional = |index: usize| -> Option<String> {
        match field(index) {
            Value::Text(text) => Some(text),
            Value::Null => None,
            other => Some(match other {
                Value::Integer(number) => number.to_string(),
                Value::Real(number) => number.to_string(),
                Value::Blob(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Value::Null | Value::Text(_) => String::new(),
            }),
        }
    };
    let integer_of = |index: usize| -> Option<i64> {
        match field(index) {
            Value::Integer(number) => Some(number),
            Value::Real(number) => Some(number as i64),
            Value::Null | Value::Text(_) | Value::Blob(_) => None,
        }
    };
    if values.len() < 13 {
        return Err(AuthError::Token(
            "a devices row is missing columns".to_owned(),
        ));
    }
    Ok(Row {
        id: string(0),
        name: string(1),
        token_hash: string(2),
        scopes: decode_scopes(&string(3)),
        created_at: integer_of(4).unwrap_or(0),
        last_seen_at: integer_of(5).unwrap_or(0),
        revoked_at: integer_of(6),
        expires_at: integer_of(7),
        install_id: optional(8),
        merged_into: optional(9),
        person: integer_of(10) == Some(1),
        standing_key: optional(11),
        account_link: optional(12),
    })
}

pub(crate) fn decode_scopes(text: &str) -> Vec<Scope> {
    let Ok(value) = ace_json::parse(text) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().and_then(Scope::parse))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn scopes_json(scopes: &[Scope]) -> String {
    let names: Vec<String> = scopes
        .iter()
        .map(|scope| format!("\"{}\"", scope.as_str()))
        .collect();
    format!("[{}]", names.join(","))
}

pub(crate) fn text(value: &str) -> Option<Value> {
    Some(Value::Text(value.to_owned()))
}

pub(crate) fn integer(value: i64) -> Option<Value> {
    Some(Value::Integer(value))
}

pub(crate) fn opt_integer(value: Option<i64>) -> Option<Value> {
    value.map(Value::Integer)
}

pub(crate) fn opt_text(value: Option<&str>) -> Option<Value> {
    value.map(|text| Value::Text(text.to_owned()))
}
