// SPDX-License-Identifier: Apache-2.0
//! The OpenCode server's HTTP surface as one table: every call the session, the
//! prompts, the commands, the MCP locations, the catalog and cleanup make
//! (`session.ts`, `prompts.ts`, `commands.ts`, `mcp-locations.ts`,
//! `mcp-registration.ts`, `extension-catalog.ts`, `metadata.ts`, `cleanup.ts`)
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

use crate::translate::data::{fields, num_str};
use ace_json::{Map, Value};

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

/// One route of the SDK's client.
struct Route {
    method: Method,
    /// The path, with `{param}` where the SDK substitutes an id.
    path: &'static str,
    /// The query fields, in the SDK's order.
    query: &'static [&'static str],
    /// The body's fields, in the SDK's order, or `None` when there is no body.
    body: Option<&'static [&'static str]>,
}

const NONE: Option<&'static [&'static str]> = None;
const fn body(fields: &'static [&'static str]) -> Option<&'static [&'static str]> {
    Some(fields)
}
const fn route(
    method: Method,
    path: &'static str,
    query: &'static [&'static str],
    body: Option<&'static [&'static str]>,
) -> Route {
    Route {
        method,
        path,
        query,
        body,
    }
}

const NO_QUERY: &[&str] = &[];
const LOCATION: &[&str] = &["location"];

/// Every call, by the SDK name the session uses.
const ROUTES: &[(&str, Route)] = &[
    // The session itself.
    (
        "session.create",
        route(
            Method::Post,
            "/api/session",
            NO_QUERY,
            body(&[
                "id",
                "parentID",
                "title",
                "agent",
                "model",
                "location",
                "metadata",
                "permissions",
            ]),
        ),
    ),
    (
        "session.get",
        route(Method::Get, "/api/session/{sessionID}", NO_QUERY, NONE),
    ),
    (
        "session.list",
        route(
            Method::Get,
            "/api/session",
            &[
                "limit",
                "order",
                "search",
                "parentID",
                "directory",
                "project",
                "subpath",
                "cursor",
            ],
            NONE,
        ),
    ),
    (
        "session.active",
        route(Method::Get, "/api/session/active", NO_QUERY, NONE),
    ),
    (
        "session.update",
        route(
            Method::Patch,
            "/api/session/{sessionID}",
            NO_QUERY,
            body(&["title", "metadata", "permissions"]),
        ),
    ),
    (
        "session.switchAgent",
        route(
            Method::Post,
            "/api/session/{sessionID}/agent",
            NO_QUERY,
            body(&["agent"]),
        ),
    ),
    (
        "session.switchModel",
        route(
            Method::Post,
            "/api/session/{sessionID}/model",
            NO_QUERY,
            body(&["model"]),
        ),
    ),
    (
        "session.interrupt",
        route(
            Method::Post,
            "/api/session/{sessionID}/interrupt",
            &["resume"],
            NONE,
        ),
    ),
    (
        "session.prompt",
        route(
            Method::Post,
            "/api/session/{sessionID}/prompt",
            NO_QUERY,
            body(&[
                "id", "text", "files", "agents", "skills", "metadata", "delivery", "resume",
            ]),
        ),
    ),
    (
        "session.command",
        route(
            Method::Post,
            "/api/session/{sessionID}/command",
            NO_QUERY,
            body(&["name", "text", "files", "agents", "skills", "delivery"]),
        ),
    ),
    (
        "session.environment",
        route(
            Method::Put,
            "/api/session/{sessionID}/environment",
            NO_QUERY,
            body(&["variables"]),
        ),
    ),
    (
        "session.instructions.put",
        route(
            Method::Put,
            "/api/experimental/session/{sessionID}/instructions/entries/{key}",
            NO_QUERY,
            body(&["value"]),
        ),
    ),
    // The session's messages, permissions, forms and inbox.
    (
        "session.message.get",
        route(
            Method::Get,
            "/api/session/{sessionID}/message/{messageID}",
            NO_QUERY,
            NONE,
        ),
    ),
    (
        "message.list",
        route(
            Method::Get,
            "/api/session/{sessionID}/message",
            &["limit", "order", "cursor", "type"],
            NONE,
        ),
    ),
    (
        "permission.list",
        route(
            Method::Get,
            "/api/session/{sessionID}/permission",
            NO_QUERY,
            NONE,
        ),
    ),
    (
        "permission.reply",
        route(
            Method::Post,
            "/api/session/{sessionID}/permission/{requestID}/reply",
            NO_QUERY,
            body(&["decision", "message"]),
        ),
    ),
    (
        "session.form.list",
        route(Method::Get, "/api/session/{sessionID}/form", NO_QUERY, NONE),
    ),
    (
        "session.form.reply",
        route(
            Method::Post,
            "/api/session/{sessionID}/form/{formID}/reply",
            NO_QUERY,
            body(&["answer"]),
        ),
    ),
    (
        "session.form.cancel",
        route(
            Method::Delete,
            "/api/session/{sessionID}/form/{formID}",
            &["message"],
            NONE,
        ),
    ),
    (
        "session.inbox.list",
        route(
            Method::Get,
            "/api/session/{sessionID}/inbox",
            NO_QUERY,
            NONE,
        ),
    ),
    // Shells.
    (
        "shell.list",
        route(Method::Get, "/api/shell", LOCATION, NONE),
    ),
    (
        "shell.get",
        route(Method::Get, "/api/shell/{id}", LOCATION, NONE),
    ),
    (
        "shell.remove",
        route(Method::Delete, "/api/shell/{id}", LOCATION, NONE),
    ),
    // The catalog.
    (
        "model.list",
        route(Method::Get, "/api/model", LOCATION, NONE),
    ),
    (
        "model.default",
        route(Method::Get, "/api/model/default", LOCATION, NONE),
    ),
    (
        "command.list",
        route(Method::Get, "/api/command", LOCATION, NONE),
    ),
    (
        "skill.list",
        route(Method::Get, "/api/skill", LOCATION, NONE),
    ),
    (
        "agent.list",
        route(Method::Get, "/api/agent", LOCATION, NONE),
    ),
    (
        "plugin.list",
        route(Method::Get, "/api/plugin", LOCATION, NONE),
    ),
    ("mcp.list", route(Method::Get, "/api/mcp", LOCATION, NONE)),
    // ace's MCP server in a location, and the plugins' two RPCs.
    (
        "mcp.add",
        route(
            Method::Put,
            "/api/experimental/mcp/{server}",
            LOCATION,
            body(&["config"]),
        ),
    ),
    (
        "mcp.connect",
        route(
            Method::Post,
            "/api/experimental/mcp/{server}/connect",
            LOCATION,
            NONE,
        ),
    ),
    (
        "agent.environment.settle",
        route(
            Method::Post,
            "/api/rpc/ace.agent.environment/settle",
            LOCATION,
            body(&["input"]),
        ),
    ),
    (
        "mcp.readiness.ready",
        route(
            Method::Post,
            "/api/rpc/ace.mcp.readiness/ready",
            LOCATION,
            body(&["input"]),
        ),
    ),
    (
        "integration.list",
        route(Method::Get, "/api/integration", LOCATION, NONE),
    ),
    // The event stream: `client.rs` reads its body as bytes, the SDK as SSE.
    (
        "event.subscribe",
        route(Method::Get, "/api/event", NO_QUERY, NONE),
    ),
];

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

/// `appendQuery`: an object is `key[child]`, an array repeats the key, null is
/// the text `null`, and a number prints as `String(value)`.
fn flatten(key: &str, value: &Value, out: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            for (nested, item) in map.iter() {
                flatten(&format!("{key}[{nested}]"), item, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                flatten(key, item, out);
            }
        }
        Value::Null => out.push((key.to_owned(), String::from("null"))),
        Value::String(text) => out.push((key.to_owned(), text.as_str().to_owned())),
        Value::Bool(hit) => out.push((key.to_owned(), hit.to_string())),
        Value::Number(number) => {
            out.push((key.to_owned(), num_str(number.as_f64().unwrap_or(0.0))));
        }
    }
}

/// `encodeURIComponent`, the encoding the SDK gives a path segment.
fn encode_segment(text: &str) -> String {
    encode(text, |byte| {
        matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\''
                | b'('
                | b')'
        )
    })
}

/// `URLSearchParams` serialization, what the SDK's query reaches the wire as: a
/// space is `+`, and `!'()~` are escaped where a path segment keeps them.
fn encode_query(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b' ' => out.push('+'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn encode(text: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if keep(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests;
