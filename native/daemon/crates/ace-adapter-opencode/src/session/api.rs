// SPDX-License-Identifier: Apache-2.0
//! The OpenCode server's HTTP surface as one table: the routes ace drives
//! (`packages/adapter-opencode/src/contract.ts` `requiredRoutes`) and every
//! call the session, the prompts, the commands, the MCP locations, the catalog
//! and cleanup make (`session.ts`, `prompts.ts`, `commands.ts`,
//! `mcp-locations.ts`, `mcp-registration.ts`, `extension-catalog.ts`,
//! `metadata.ts`, `cleanup.ts`).
//!
//! A call is sans-IO: the method, the path with its ids substituted, the
//! bracket-encoded query the SDK builds (`{location:{directory}}` is
//! `location[directory]=…`), and the JSON body with the path's ids removed.
//! `client.rs` sends it; `Reply` (E3-opencode.3's `http.rs`) reads the answer.

use crate::translate::data::{fields, num_str};
use ace_json::{Map, Value};

/// One request the server answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub method: Method,
    pub path: String,
    /// `key=value` pairs, unencoded, in the SDK's order.
    pub query: Vec<(String, String)>,
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
    let p = fields(params);
    match op {
        // The session itself.
        "session.create" => Ok(post("/api/session").body(params)),
        "session.get" => Ok(get(&session_path(p, op, "")?)),
        "session.list" => Ok(get("/api/session").query(&[
            ("parentID", p.get("parentID")),
            ("directory", p.get("directory")),
            ("project", p.get("project")),
            ("limit", p.get("limit")),
            ("cursor", p.get("cursor")),
            ("order", p.get("order")),
        ])),
        "session.active" => Ok(get("/api/session/active")),
        "session.update" => Ok(patch(&session_path(p, op, "")?).body(&strip(p, &["sessionID"]))),
        "session.switchAgent" => {
            Ok(post(&session_path(p, op, "/agent")?).body(&strip(p, &["sessionID"])))
        }
        "session.switchModel" => {
            Ok(post(&session_path(p, op, "/model")?).body(&strip(p, &["sessionID"])))
        }
        "session.interrupt" => {
            Ok(post(&session_path(p, op, "/interrupt")?).body(&strip(p, &["sessionID"])))
        }
        "session.prompt" => {
            Ok(post(&session_path(p, op, "/prompt")?).body(&strip(p, &["sessionID"])))
        }
        "session.command" => {
            Ok(post(&session_path(p, op, "/command")?).body(&strip(p, &["sessionID"])))
        }
        "session.environment" => {
            Ok(put(&session_path(p, op, "/environment")?).body(&strip(p, &["sessionID"])))
        }
        "session.instructions.put" => Ok(put(&session_path(
            p,
            op,
            &format!("/instructions/entries/{}", segment(p, "key", op)?),
        )?)
        .body(&strip(p, &["sessionID", "key"]))),
        // The session's messages, permissions, forms and inbox.
        "session.message.get" => Ok(get(&session_path(
            p,
            op,
            &format!("/message/{}", segment(p, "messageID", op)?),
        )?)),
        "message.list" => Ok(get(&session_path(p, op, "/message")?).query(&[
            ("limit", p.get("limit")),
            ("cursor", p.get("cursor")),
            ("order", p.get("order")),
        ])),
        "permission.list" => Ok(get(&session_path(p, op, "/permission")?)),
        "permission.reply" => Ok(post(&session_path(
            p,
            op,
            &format!("/permission/{}/reply", segment(p, "requestID", op)?),
        )?)
        .body(&strip(p, &["sessionID", "requestID"]))),
        "session.form.list" => Ok(get(&session_path(p, op, "/form")?)),
        "session.form.reply" => Ok(post(&session_path(
            p,
            op,
            &format!("/form/{}/reply", segment(p, "formID", op)?),
        )?)
        .body(&strip(p, &["sessionID", "formID"]))),
        "session.form.cancel" => Ok(delete(&session_path(
            p,
            op,
            &format!("/form/{}", segment(p, "formID", op)?),
        )?)
        .body(&strip(p, &["sessionID", "formID"]))),
        "session.inbox.list" => Ok(get(&session_path(p, op, "/inbox")?)),
        // Shells.
        "shell.list" => Ok(get("/api/shell").query(&location(p))),
        "shell.get" => {
            Ok(get(&format!("/api/shell/{}", segment(p, "id", op)?)).query(&location(p)))
        }
        "shell.remove" => {
            Ok(delete(&format!("/api/shell/{}", segment(p, "id", op)?)).query(&location(p)))
        }
        // The catalog.
        "model.list" => Ok(get("/api/model").query(&location(p))),
        "model.default" => Ok(get("/api/model/default").query(&location(p))),
        "command.list" => Ok(get("/api/command").query(&location(p))),
        "skill.list" => Ok(get("/api/skill").query(&location(p))),
        "agent.list" => Ok(get("/api/agent").query(&location(p))),
        "plugin.list" => Ok(get("/api/plugin").query(&location(p))),
        "mcp.list" => Ok(get("/api/mcp").query(&location(p))),
        // ace's MCP server in a location, and the plugins' two RPCs.
        "mcp.add" => Ok(put("/api/experimental/mcp/ace")
            .body(&strip(p, &["location"]))
            .query(&location(p))),
        "mcp.connect" => Ok(post("/api/experimental/mcp/ace/connect")
            .body(&strip(p, &["location"]))
            .query(&location(p))),
        "agent.environment.settle" => {
            Ok(post("/api/rpc/ace.agent.environment/settle").body(&json_body("input", params)))
        }
        "mcp.readiness.ready" => Ok(post("/api/rpc/ace.mcp.readiness/ready").body(params)),
        "integration.list" => Ok(get("/api/integration")),
        // The event stream: `client.rs` reads its body as bytes.
        "event.subscribe" => Ok(get("/api/event")),
        other => Err(ApiError::Unknown(other.to_owned())),
    }
}

/// `/api/session/{id}{suffix}`.
fn session_path(p: &Map, op: &str, suffix: &str) -> Result<String, ApiError> {
    Ok(format!(
        "/api/session/{}{suffix}",
        segment(p, "sessionID", op)?
    ))
}

/// One path segment, percent-encoded as `encodeURIComponent` does.
fn segment(p: &Map, name: &'static str, op: &str) -> Result<String, ApiError> {
    match p.get(name) {
        Some(Value::String(text)) if !text.is_empty() => Ok(encode_segment(text)),
        _ => Err(ApiError::Missing(op.to_owned(), name)),
    }
}

/// `{ location: { directory } }` as the SDK's query.
fn location(p: &Map) -> Vec<(&'static str, Option<&Value>)> {
    vec![("location", p.get("location"))]
}

/// The body without the ids the path carries, as the SDK builds it.
fn strip(p: &Map, remove: &[&str]) -> Value {
    let mut body = Map::new();
    for (key, value) in p.iter() {
        if !remove.contains(&key.as_str()) {
            body.insert(key.clone(), value.clone());
        }
    }
    Value::Object(body)
}

/// `{ [name]: params }`, for the RPC that wraps its argument.
fn json_body(name: &str, params: &Value) -> Value {
    let mut body = Map::new();
    body.insert(name.to_owned(), params.clone());
    Value::Object(body)
}

fn get(path: &str) -> Call {
    Call {
        method: Method::Get,
        path: path.to_owned(),
        query: Vec::new(),
        body: None,
    }
}

fn post(path: &str) -> Call {
    with_body(Method::Post, path)
}

fn put(path: &str) -> Call {
    with_body(Method::Put, path)
}

fn patch(path: &str) -> Call {
    with_body(Method::Patch, path)
}

fn delete(path: &str) -> Call {
    with_body(Method::Delete, path)
}

fn with_body(method: Method, path: &str) -> Call {
    Call {
        method,
        path: path.to_owned(),
        query: Vec::new(),
        body: None,
    }
}

impl Call {
    /// The query the SDK's serializer builds: a nested object is
    /// `key[sub]=…`, a number prints as `JSON.stringify` does, and an absent or
    /// null value is left out.
    fn query(mut self, pairs: &[(&str, Option<&Value>)]) -> Self {
        for (key, value) in pairs {
            if let Some(value) = value {
                flatten(key, value, &mut self.query);
            }
        }
        self
    }

    fn body(mut self, body: &Value) -> Self {
        self.body = Some(body.clone());
        self
    }

    /// The path and query as one request target.
    pub fn target(&self) -> String {
        if self.query.is_empty() {
            return self.path.clone();
        }
        let query: Vec<String> = self
            .query
            .iter()
            .map(|(key, value)| format!("{}={}", encode_segment(key), encode_value(value)))
            .collect();
        format!("{}?{}", self.path, query.join("&"))
    }
}

fn flatten(key: &str, value: &Value, out: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            for (nested, item) in map.iter() {
                flatten(&format!("{key}[{nested}]"), item, out);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                flatten(&format!("{key}[{index}]"), item, out);
            }
        }
        Value::Null => {}
        Value::String(text) => out.push((key.to_owned(), text.as_str().to_owned())),
        Value::Bool(hit) => out.push((key.to_owned(), hit.to_string())),
        Value::Number(number) => {
            out.push((key.to_owned(), num_str(number.as_f64().unwrap_or(0.0))));
        }
    }
}

/// `encodeURIComponent`, the encoding the SDK's query uses.
pub fn encode_value(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A path segment: `/` and `?` must not escape their place.
fn encode_segment(text: &str) -> String {
    encode_value(text)
}

#[cfg(test)]
mod tests;
