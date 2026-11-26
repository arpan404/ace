// SPDX-License-Identifier: Apache-2.0
//! The OpenCode server's HTTP surface as one table: every call the session, the
//! prompts, the commands, the MCP locations, the catalog and cleanup make
//! (`session.ts`, `prompts.ts`, `commands.ts`, `mcp-locations.ts`,
//! `mcp-registration.ts`, `mcp-controls.ts`, `extension-catalog.ts`, `metadata.ts`,
//! `cleanup.ts`)
//! and the routes `contract.ts` insists the server still serves.
//!
//! Each entry is the `@opencode/client` route it replaces: the method, the path
//! with its ids in place, the query fields the SDK sends (in its order) and the
//! body's field whitelist. A param the route does not name never reaches the
//! wire, and a field the route names is sent whenever the caller passes it, in
//! the SDK's bracket encoding (`{location:{directory}}` is
//! `location[directory]=…`). `routes.golden.json` records what the SDK actually
//! sends for the same params, and the tests compare the two.
//!
//! A call is sans-IO. `http.rs` sends it; `Reply` reads the answer.

mod encode;
mod routes;

use crate::translate::data::fields;
use ace_json::{Map, Value};

use encode::{encode_query, encode_segment, flatten};
use routes::ROUTES;

/// One request the server answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub method: Method,
    pub path: String,
    /// `key=value` pairs, unencoded, in the SDK's order.
    pub query: Vec<(String, String)>,
    /// The JSON body, or `None` for a route the SDK sends no body on.
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

/// Why a call could not be built. A name the table does not know, or a param
/// the route needs, is the TypeScript's TypeError before any request goes out.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    #[error("OpenCode client call is unknown: {0}")]
    Unknown(String),
    #[error("OpenCode client call {0} needs {1}")]
    Missing(String, &'static str),
}

/// One SDK call, by the name E3-opencode.3's `http` ports use.
pub fn call(op: &str, params: &Value) -> Result<Call, ApiError> {
    let Some((_, route)) = ROUTES.iter().find(|(name, _)| *name == op) else {
        return Err(ApiError::Unknown(op.to_owned()));
    };
    let p = fields(params);
    let mut query = Vec::new();
    for name in route.query {
        if let Some(value) = p.get(*name) {
            flatten(name, value, &mut query);
        }
    }
    Ok(Call {
        method: route.method,
        path: path(p, op, route.path)?,
        query,
        body: route.body.map(|names| fields_of(p, names)),
    })
}

/// The table's names, in table order.
pub fn ops() -> impl Iterator<Item = &'static str> {
    ROUTES.iter().map(|(name, _)| *name)
}

/// The path with its `{param}` ids substituted and percent-encoded.
fn path(p: &Map, op: &str, template: &'static str) -> Result<String, ApiError> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after
            .find('}')
            .ok_or_else(|| ApiError::Unknown(op.to_owned()))?;
        out.push_str(&segment(p, &after[..end], op)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// One path segment, percent-encoded as `encodeURIComponent` does.
fn segment(p: &Map, name: &'static str, op: &str) -> Result<String, ApiError> {
    match p.get(name) {
        Some(Value::String(text)) if !text.is_empty() => Ok(encode_segment(text.as_str())),
        _ => Err(ApiError::Missing(op.to_owned(), name)),
    }
}

/// The body: the route's fields that the caller passed, in the SDK's order. A
/// null is a value the SDK sends; an absent field is one it omits.
fn fields_of(p: &Map, names: &[&str]) -> Value {
    let mut body = Map::new();
    for name in names {
        if let Some(value) = p.get(*name) {
            body.insert((*name).to_owned(), value.clone());
        }
    }
    Value::Object(body)
}

impl Call {
    /// The path and query as one request target, in the SDK's wire shape.
    pub fn target(&self) -> String {
        if self.query.is_empty() {
            return self.path.clone();
        }
        let query: Vec<String> = self
            .query
            .iter()
            .map(|(key, value)| format!("{}={}", encode_query(key), encode_query(value)))
            .collect();
        format!("{}?{}", self.path, query.join("&"))
    }
}

#[cfg(test)]
mod tests;
