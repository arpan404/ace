// SPDX-License-Identifier: Apache-2.0
//! Search terms, fingerprints and cursors, as `thread-query.ts` reads them.
//!
//! The fingerprint and cursor serialize their fields in the protocol's order.

use super::super::common::{LongError, invalid};
use super::super::row::{json_string, strs_json};
use serde::Deserialize;

pub fn extract_terms(text: &str) -> Result<Vec<String>, LongError> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '_' || ch.is_alphanumeric() {
            current.push(ch);
        } else if ch.is_ascii() {
            if !current.is_empty() {
                terms.push(current.clone());
                current.clear();
            }
        } else {
            // Combining marks (`\p{M}`) join a term; anything else ends it.
            let mark = ('\u{300}'..='\u{36f}').contains(&ch)
                || ('\u{1ab0}'..='\u{1aff}').contains(&ch)
                || ('\u{1dc0}'..='\u{1dff}').contains(&ch)
                || ('\u{20d0}'..='\u{20ff}').contains(&ch)
                || ('\u{fe20}'..='\u{fe2f}').contains(&ch);
            if mark {
                current.push(ch);
            } else if !current.is_empty() {
                terms.push(current.clone());
                current.clear();
            }
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }
    if terms.is_empty() || terms.len() > 64 {
        return Err(invalid("search_invalid_query"));
    }
    Ok(terms)
}

pub fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// The query fingerprint, in the order `thread-query.ts` stringifies it.
pub fn fingerprint_text(
    trimmed: &str,
    filter: Option<&str>,
    scope: &str,
    sorted_ids: &[String],
) -> Result<String, LongError> {
    let mut out = String::with_capacity(trimmed.len() + scope.len() + sorted_ids.len() * 40 + 64);
    out.push_str("{\"text\":");
    out.push_str(&json_string(trimmed)?);
    if let Some(filter) = filter {
        out.push_str(",\"filter\":");
        out.push_str(&json_string(filter)?);
    }
    out.push_str(",\"scope\":");
    out.push_str(&json_string(scope)?);
    out.push_str(",\"threadIds\":");
    out.push_str(&strs_json(sorted_ids)?);
    out.push('}');
    Ok(out)
}

#[derive(Deserialize)]
pub struct CursorJson<'a> {
    #[serde(borrow, default)]
    pub fingerprint: Option<&'a str>,
    #[serde(default, borrow)]
    pub id: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub ceiling: Option<&'a serde_json::value::RawValue>,
    #[serde(borrow, default)]
    pub anchor: Option<&'a str>,
}

pub fn raw_int(raw: &serde_json::value::RawValue) -> Result<i64, LongError> {
    serde_json::from_str(raw.get()).map_err(|_| invalid("search_invalid_query"))
}

pub fn cursor_json(
    fingerprint: &str,
    id: i64,
    ceiling: i64,
    anchor: &str,
) -> Result<String, LongError> {
    let json_string = super::super::row::json_string;
    Ok(format!(
        "{{\"fingerprint\":{},\"id\":{id},\"ceiling\":{ceiling},\"anchor\":{}}}",
        json_string(fingerprint)?,
        json_string(anchor)?,
    ))
}
