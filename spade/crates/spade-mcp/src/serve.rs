//! Spade as an MCP server, for the person's own agents (ADR 0202 §3): the tools it offers, how
//! one JSON-RPC message posted to it is read, and each answer. Pure: no I/O and no transport, so
//! Spade's API serves it over HTTP behind ace's grant and tests read it directly.
//!
//! It speaks both eras of MCP's streamable HTTP binding. A request whose `_meta` names
//! `io.modelcontextprotocol/protocolVersion` is served statelessly at [`MODERN`] (2026-07-28:
//! `server/discover`, `resultType`, the version in a header that must match). A client that
//! opens with `initialize` is served at the legacy version it asks for (2025-11-25 and the two
//! before it), with no session: every request stands alone either way.

use serde_json::{Map, Value, json};

/// The stateless protocol version.
pub const MODERN: &str = "2026-07-28";
/// The `initialize` versions served, newest first.
pub const LEGACY: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
const VERSION_META: &str = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META: &str = "io.modelcontextprotocol/serverInfo";
/// Where a caller may give its own idempotency key for a `tools/call`: the same key never runs
/// the call twice.
pub const KEY_META: &str = "dev.acehq.spade/key";
/// Set on a result whose output came from a callee that read untrusted content (ADR 0152 §6).
pub const UNTRUSTED_META: &str = "dev.acehq.spade/untrusted";

/// The JSON-RPC error codes this server answers with.
pub mod code {
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const PARSE_ERROR: i64 = -32700;
    pub const HEADER_MISMATCH: i64 = -32020;
    pub const UNSUPPORTED_VERSION: i64 = -32022;
}

/// How a client speaks: per request (modern) or after `initialize` (legacy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Era {
    Modern,
    Legacy,
}

/// The HTTP headers MCP mirrors from the body, as the request carried them.
#[derive(Debug, Clone, Copy, Default)]
pub struct Headers<'a> {
    /// `MCP-Protocol-Version`.
    pub version: Option<&'a str>,
    /// `Mcp-Method`.
    pub method: Option<&'a str>,
    /// `Mcp-Name`.
    pub name: Option<&'a str>,
}

/// What a message asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Method {
    Discover,
    /// `initialize`, with the version the client asked for.
    Initialize(String),
    Ping,
    ListTools,
    CallTool {
        name: String,
        arguments: Value,
        /// The caller's idempotency key, from `_meta`, when it gave one.
        key: Option<String>,
    },
    /// `notifications/cancelled`: the request it names should stop.
    Cancelled(Value),
    /// Any other notification: taken, and nothing to do.
    Notification,
}

/// One message as read.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    /// The request's id; `None` for a notification.
    pub id: Option<Value>,
    pub era: Era,
    pub method: Method,
}

/// An HTTP answer: a status and the JSON body, `None` for `202 Accepted` with no body.
pub type Answer = (u16, Option<Value>);

/// A tool offered: a contract of one of the person's bots, as `tools/list` shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Offer {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input: Value,
    pub output: Value,
    /// The contract's held effects, by name (`network`, `publish`, …).
    pub effects: Vec<String>,
}

/// How a call ended, as its answer says it.
#[derive(Debug, Clone, PartialEq)]
pub enum Called {
    /// The callee returned output that fits the contract's schema.
    Returned { output: Value, untrusted: bool },
    /// It ran and did not return: it failed, was stopped, or its input didn't fit. The model
    /// reads the text and may try again.
    Failed(String),
    /// No tool by that name is offered to this caller.
    NoSuchTool(String),
    /// A request with the same id is still running: JSON-RPC ids are unique among a client's
    /// requests in flight, and a cancellation names one by its id.
    DuplicateId,
}

/// Who answers, for `serverInfo`.
#[derive(Debug, Clone, Copy)]
pub struct Server<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub instructions: &'a str,
}

/// The tool name for contract `contract` of the bot called `bot`: `<bot slug>__<contract>`,
/// within MCP's 128 characters of `A-Za-z0-9_-.`.
pub fn tool_name(bot: &str, contract: &str) -> String {
    let mut slug = String::new();
    for c in bot.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('_') {
            slug.push('_');
        }
    }
    let slug = slug.trim_end_matches('_');
    let slug = if slug.is_empty() { "bot" } else { slug };
    let contract: String = contract
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let room = 126usize.saturating_sub(contract.len()).max(1);
    let slug: String = slug.chars().take(room).collect();
    format!("{slug}__{contract}")
}

impl Offer {
    /// The tool as `tools/list` lists it. Its annotations come from the contract's effects only,
    /// never from a claim: read-only only when it holds none, open-world when it holds
    /// `network`, and never a destructive hint.
    pub fn to_json(&self) -> Value {
        let mut annotations = Map::new();
        annotations.insert("title".into(), json!(self.title));
        if self.effects.is_empty() {
            annotations.insert("readOnlyHint".into(), json!(true));
        }
        let open = self.effects.iter().any(|e| e == "network");
        annotations.insert("openWorldHint".into(), json!(open));
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input,
            "outputSchema": self.output,
            "annotations": annotations,
            "_meta": { "dev.acehq.spade/effects": self.effects },
        })
    }
}

fn envelope(id: Option<&Value>) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert("jsonrpc".into(), json!("2.0"));
    body.insert("id".into(), id.cloned().unwrap_or(Value::Null));
    body
}

/// A JSON-RPC error answer.
pub fn error(
    status: u16,
    id: Option<&Value>,
    code: i64,
    message: &str,
    data: Option<Value>,
) -> Answer {
    let mut fault = json!({ "code": code, "message": message });
    if let Some(data) = data {
        fault["data"] = data;
    }
    let mut body = envelope(id);
    body.insert("error".into(), fault);
    (status, Some(Value::Object(body)))
}

fn supported() -> Value {
    let mut all = vec![MODERN];
    all.extend(LEGACY);
    json!(all)
}

/// Reads one posted message, or the error answer it gets.
pub fn read(body: &[u8], headers: Headers<'_>) -> Result<Message, Answer> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Err(error(400, None, code::PARSE_ERROR, "Invalid JSON", None));
    };
    let Some(object) = value.as_object() else {
        // Batches were removed from MCP; one message per POST.
        return Err(error(
            400,
            None,
            code::INVALID_REQUEST,
            "Send one JSON-RPC message",
            None,
        ));
    };
    let id = object
        .get("id")
        .filter(|id| id.is_string() || id.is_number())
        .cloned();
    let invalid = |why: &str| error(400, id.as_ref(), code::INVALID_REQUEST, why, None);
    if object.get("jsonrpc") != Some(&json!("2.0")) {
        return Err(invalid("Not a JSON-RPC 2.0 message"));
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Err(invalid("A client sends requests and notifications only"));
    };
    if object.contains_key("id") && id.is_none() {
        return Err(invalid("A request's id is a string or a number"));
    }
    let empty = Value::Object(Map::new());
    let params = object.get("params").unwrap_or(&empty);
    let mismatch = |why: String| error(400, id.as_ref(), code::HEADER_MISMATCH, &why, None);
    if let Some(named) = headers.method
        && named != method
    {
        return Err(mismatch(format!(
            "Header mismatch: Mcp-Method header value '{named}' does not match body value '{method}'"
        )));
    }
    let body_version = params["_meta"][VERSION_META].as_str();
    let era = if method == "initialize" {
        Era::Legacy
    } else if let Some(version) = body_version {
        if headers.version != Some(version) {
            return Err(mismatch(format!(
                "Header mismatch: MCP-Protocol-Version header value '{}' does not match body value '{version}'",
                headers.version.unwrap_or("")
            )));
        }
        if version != MODERN {
            return Err(error(
                400,
                id.as_ref(),
                code::UNSUPPORTED_VERSION,
                "Unsupported protocol version",
                Some(json!({ "supported": supported(), "requested": version })),
            ));
        }
        Era::Modern
    } else {
        if headers.version == Some(MODERN) {
            return Err(mismatch(format!(
                "Header mismatch: MCP-Protocol-Version header value '{MODERN}' but the body names no version"
            )));
        }
        Era::Legacy
    };
    let not_found = || {
        let status = if era == Era::Modern { 404 } else { 200 };
        error(
            status,
            id.as_ref(),
            code::METHOD_NOT_FOUND,
            "Method not found",
            None,
        )
    };
    let method = match (method, id.is_some()) {
        ("server/discover", true) if era == Era::Modern => Method::Discover,
        ("initialize", true) => Method::Initialize(
            params["protocolVersion"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        ),
        ("ping", true) => Method::Ping,
        ("tools/list", true) => Method::ListTools,
        ("tools/call", true) => {
            let Some(name) = params["name"].as_str() else {
                return Err(error(
                    400,
                    id.as_ref(),
                    code::INVALID_PARAMS,
                    "tools/call names its tool",
                    None,
                ));
            };
            if let Some(named) = headers.name
                && named != name
            {
                return Err(mismatch(format!(
                    "Header mismatch: Mcp-Name header value '{named}' does not match body value '{name}'"
                )));
            }
            Method::CallTool {
                name: name.to_owned(),
                arguments: params.get("arguments").cloned().unwrap_or(empty.clone()),
                key: params["_meta"][KEY_META].as_str().map(str::to_owned),
            }
        }
        ("notifications/cancelled", false) => {
            Method::Cancelled(params.get("requestId").cloned().unwrap_or(Value::Null))
        }
        (other, false) if other.starts_with("notifications/") => Method::Notification,
        _ => return Err(not_found()),
    };
    Ok(Message { id, era, method })
}

/// A result answer: in the modern era it says it is complete and who answered.
fn result(message: &Message, server: Server<'_>, mut result: Map<String, Value>) -> Answer {
    if message.era == Era::Modern {
        result.insert("resultType".into(), json!("complete"));
        let meta = result
            .entry("_meta")
            .or_insert_with(|| Value::Object(Map::new()));
        meta[SERVER_INFO_META] = json!({ "name": server.name, "version": server.version });
    }
    let mut body = envelope(message.id.as_ref());
    body.insert("result".into(), Value::Object(result));
    (200, Some(Value::Object(body)))
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `202 Accepted` for a notification.
pub fn accepted() -> Answer {
    (202, None)
}

/// The answer to `server/discover`.
pub fn discovered(message: &Message, server: Server<'_>) -> Answer {
    result(
        message,
        server,
        object(json!({
            "supportedVersions": supported(),
            "capabilities": { "tools": {} },
            "instructions": server.instructions,
        })),
    )
}

/// The answer to `initialize`: the version asked for when it is served, else the newest legacy
/// one, which the client may refuse.
pub fn initialized(message: &Message, server: Server<'_>, asked: &str) -> Answer {
    let version = LEGACY.iter().find(|v| **v == asked).unwrap_or(&LEGACY[0]);
    result(
        message,
        server,
        object(json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": server.name, "version": server.version },
            "instructions": server.instructions,
        })),
    )
}

/// The answer to `ping`.
pub fn pong(message: &Message, server: Server<'_>) -> Answer {
    result(message, server, Map::new())
}

/// The answer to `tools/list`.
pub fn listed(message: &Message, server: Server<'_>, offers: &[Offer]) -> Answer {
    let tools: Vec<Value> = offers.iter().map(Offer::to_json).collect();
    result(message, server, object(json!({ "tools": tools })))
}

/// The answer to `tools/call`. Output is given as `structuredContent` and, as the spec asks,
/// as its JSON in a text block too; whether it is untrusted travels in `_meta`.
pub fn called(message: &Message, server: Server<'_>, outcome: &Called) -> Answer {
    match outcome {
        Called::Returned { output, untrusted } => result(
            message,
            server,
            object(json!({
                "content": [{ "type": "text", "text": output.to_string() }],
                "structuredContent": output,
                "isError": false,
                "_meta": { UNTRUSTED_META: untrusted },
            })),
        ),
        Called::Failed(text) => result(
            message,
            server,
            object(json!({
                "content": [{ "type": "text", "text": text }],
                "isError": true,
            })),
        ),
        Called::NoSuchTool(name) => error(
            200,
            message.id.as_ref(),
            code::INVALID_PARAMS,
            &format!("Unknown tool: {name}"),
            None,
        ),
        Called::DuplicateId => error(
            200,
            message.id.as_ref(),
            code::INVALID_REQUEST,
            "A request with this id is still running; give each request its own id.",
            None,
        ),
    }
}

#[cfg(test)]
mod tests;
