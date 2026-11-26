// SPDX-License-Identifier: Apache-2.0
//! The client-daemon wire (ADR 0226 §3): the envelope a socket reads first, the body decoded
//! with its generated `ace-protocol` type, and outbound messages written through `ace-json` in
//! the key order Zod's parse gives them.
//!
//! `packages/protocol` stays the one source of truth. The types in [`ace_protocol::generated`]
//! and the shapes in [`ace_protocol::shapes`] are generated from it; this crate adds only what
//! JSON Schema can't express (refinements) and the envelope rules the transport owns.
//!
//! Inbound, [`envelope`] is all the transport needs for a message a JavaScript owner handles:
//! the `type` and the routing ids, with the body left as received. A Rust owner calls
//! [`decode_client`] or [`decode_server`] for the generated type. Outbound, [`encode_client`]
//! and [`encode_server`] write in the schema's key order, never the struct's.

pub mod error;
pub mod refine;

#[cfg(test)]
mod tests;

pub use error::WireError;

use ace_json::{Map, Value};
use ace_protocol::shape::{Shape, strip};
use ace_protocol::shapes::{
    BROWSER_BACKEND_CLIENT_MESSAGE, BROWSER_BACKEND_SERVER_MESSAGE, CLIENT_MESSAGE, SERVER_MESSAGE,
    USER_BROWSER_EXTENSION_MESSAGE,
};
use ace_protocol::wire::{ClientBody, ServerBody, decode_client as decode_client_body};

/// Every union the daemon accepts from a client: the full `ClientMessage`, and the two
/// browser-worker and extension unions the daemon's socket also takes.
static CLIENT_ROOTS: [&Shape; 3] = [
    &CLIENT_MESSAGE,
    &BROWSER_BACKEND_CLIENT_MESSAGE,
    &USER_BROWSER_EXTENSION_MESSAGE,
];

/// Every union the daemon accepts from itself toward a browser worker.
static SERVER_ROOTS: [&Shape; 2] = [&SERVER_MESSAGE, &BROWSER_BACKEND_SERVER_MESSAGE];

/// What the transport reads before it hands a message on: its `type` and its routing ids.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    /// The message's `type`, exactly as received.
    pub type_: String,
    /// `requestId`, for a request whose reply names it.
    pub request_id: Option<String>,
    /// `subscriptionId`, for a subscription message.
    pub subscription_id: Option<String>,
    /// The thread a read or command names, for its lane.
    pub thread_id: Option<String>,
    /// The workspace a command names, for its lane.
    pub workspace_id: Option<String>,
}

/// A client message the transport accepted: the envelope, the raw body, and its generated type.
pub struct ClientEnvelope {
    pub envelope: Envelope,
    /// The body as parsed, still in its own key order; what a TypeScript owner receives.
    pub value: Value,
    /// The same body decoded with its generated type.
    pub message: ClientBody,
}

/// A server message the daemon built, decoded back to its value for the wire.
pub struct ServerEnvelope {
    pub envelope: Envelope,
    pub value: Value,
    pub message: ServerBody,
}

/// The envelope `value` carries: its `type` and routing ids, without decoding the body.
pub fn envelope(value: &Value) -> Result<Envelope, WireError> {
    let Value::Object(map) = value else {
        return Err(WireError::NotAnObject);
    };
    let type_ = string_field(map, "type").ok_or(WireError::MissingType)?;
    let mut envelope = Envelope {
        type_,
        request_id: string_field(map, "requestId"),
        subscription_id: string_field(map, "subscriptionId"),
        thread_id: string_field(map, "threadId"),
        workspace_id: string_field(map, "workspaceId"),
    };
    if envelope.type_ == "command" {
        // A command's lane is its payload's thread or project, not the frame's.
        if let Some(Value::Object(command)) = map.get("command")
            && let Some(Value::Object(payload)) = command.get("payload")
        {
            envelope.thread_id = string_field(payload, "threadId").or(envelope.thread_id);
            envelope.workspace_id = string_field(payload, "workspaceId")
                .or_else(|| string_field(payload, "projectId"))
                .or(envelope.workspace_id);
        }
    }
    Ok(envelope)
}

/// A client message: the envelope, the body decoded with its generated type, and its value.
pub fn decode_client(text: &str) -> Result<ClientEnvelope, WireError> {
    let value = parse(text)?;
    decode_client_value(value)
}

/// [`decode_client`] over an already parsed body.
pub fn decode_client_value(value: Value) -> Result<ClientEnvelope, WireError> {
    let envelope = envelope(&value)?;
    let shape = client_option(&envelope.type_).ok_or_else(|| WireError::UnknownType {
        type_: envelope.type_.clone(),
    })?;
    // A union decodes by shape, so a body may satisfy another message's variant. The type's
    // own shape decides whether this body is the message it names.
    if !ace_protocol::shape::fits(shape, &value) {
        return Err(WireError::Rejected {
            type_: envelope.type_.clone(),
        });
    }
    // Zod fills defaults and applies transforms before its output exists; refinements run on
    // that normalized value, not the raw body.
    let shaped = strip(shape, &value);
    refine::client(&envelope.type_, &shaped)?;
    let message = decode_client_body(&envelope.type_, &shaped)
        .ok_or_else(|| WireError::UnknownType {
            type_: envelope.type_.clone(),
        })?
        .map_err(WireError::Body)?;
    Ok(ClientEnvelope {
        envelope,
        value,
        message,
    })
}

/// A server message: the envelope, and the body decoded with its generated type.
pub fn decode_server(text: &str) -> Result<ServerEnvelope, WireError> {
    let value = parse(text)?;
    let envelope = envelope(&value)?;
    let shape = server_option(&envelope.type_).ok_or_else(|| WireError::UnknownType {
        type_: envelope.type_.clone(),
    })?;
    if !ace_protocol::shape::fits(shape, &value) {
        return Err(WireError::Rejected {
            type_: envelope.type_.clone(),
        });
    }
    let shaped = strip(shape, &value);
    refine::server(&envelope.type_, &shaped)?;
    let message = ace_protocol::wire::decode_server(&envelope.type_, &shaped)
        .ok_or_else(|| WireError::UnknownType {
            type_: envelope.type_.clone(),
        })?
        .map_err(WireError::Body)?;
    Ok(ServerEnvelope {
        envelope,
        value,
        message,
    })
}

/// `value` as the bytes a client parses: through `ace-json`, in the schema's key order.
/// A Rust producer builds or splices a value; this is the one writer for it.
pub fn encode_client(value: &Value) -> Result<String, WireError> {
    let envelope = envelope(value)?;
    let shape = client_option(&envelope.type_).ok_or_else(|| WireError::UnknownType {
        type_: envelope.type_.clone(),
    })?;
    write(shape, value)
}

/// `value` as the bytes a client parses: through `ace-json`, in the schema's key order.
pub fn encode_server(value: &Value) -> Result<String, WireError> {
    let envelope = envelope(value)?;
    let shape = server_option(&envelope.type_).ok_or_else(|| WireError::UnknownType {
        type_: envelope.type_.clone(),
    })?;
    write(shape, value)
}

/// `body` as the bytes a client parses: its own generated type, then Zod's key order. Fails
/// where a generated type cannot round-trip (a union typify emitted as a flattened struct, such
/// as `ThreadStatus`); a producer that hits one writes the value instead.
pub fn encode_client_body(body: &ClientBody) -> Result<String, WireError> {
    let text = ace_protocol::wire::encode_client(body).map_err(WireError::Body)?;
    let shape = client_option(body.type_()).ok_or_else(|| WireError::UnknownType {
        type_: body.type_().to_string(),
    })?;
    Ok(ace_json::to_string(&strip(shape, &parse(&text)?)))
}

/// `body` as the bytes a client parses, as [`encode_client_body`].
pub fn encode_server_body(body: &ServerBody) -> Result<String, WireError> {
    let text = ace_protocol::wire::encode_server(body).map_err(WireError::Body)?;
    let shape = server_option(body.type_()).ok_or_else(|| WireError::UnknownType {
        type_: body.type_().to_string(),
    })?;
    Ok(ace_json::to_string(&strip(shape, &parse(&text)?)))
}

fn parse(text: &str) -> Result<Value, WireError> {
    ace_json::parse(text).map_err(|error| WireError::Json(error.to_string()))
}

fn write(shape: &'static Shape, value: &Value) -> Result<String, WireError> {
    Ok(ace_json::to_string(&strip(shape, value)))
}

/// What Zod's parse keeps of a client message, across every union the socket accepts.
pub fn canonical_client(type_: &str, value: &Value) -> Option<Value> {
    client_option(type_).map(|shape| strip(shape, value))
}

/// What Zod's parse keeps of `value` for the message of `type` in `root`: fields in schema
/// order, defaults at their place, unknown keys dropped. `None` when `type` names no message.
pub fn canonical(root: &'static Shape, type_: &str, value: &Value) -> Option<Value> {
    option(root, type_).map(|shape| strip(shape, value))
}

/// The shape one client message type's body has, in any of the client unions.
fn client_option(type_: &str) -> Option<&'static Shape> {
    CLIENT_ROOTS.iter().find_map(|root| option(root, type_))
}

/// The shape one server message type's body has, in any of the server unions.
fn server_option(type_: &str) -> Option<&'static Shape> {
    SERVER_ROOTS.iter().find_map(|root| option(root, type_))
}

/// The shape one message type's body has. A union may be tagged (`Tagged`) or a plain union
/// of objects (`OneOf`), and an object's own `type` field may be the literal that names it.
fn option(root: &'static Shape, type_: &str) -> Option<&'static Shape> {
    let printed = ace_json::to_string(&Value::String(ace_json::JsString::from(type_)));
    fn find(shape: &'static Shape, printed: &str) -> Option<&'static Shape> {
        match shape {
            Shape::Tagged { key, options } if *key == "type" => options
                .iter()
                .find(|(literal, _)| *literal == printed)
                .map(|(_, option)| option),
            Shape::OneOf(options) => options.iter().find_map(|option| find(option, printed)),
            Shape::Object { fields, .. } => {
                let named = fields.iter().any(|field| {
                    field.key == "type"
                        && matches!(
                            field.shape,
                            Shape::Enum(values) if values.contains(&printed)
                        )
                });
                named.then_some(shape)
            }
            _ => None,
        }
    }
    find(root, &printed)
}

/// A string field, when its value is a string JavaScript can read as one.
fn string_field(map: &Map, key: &str) -> Option<String> {
    match map.get(key) {
        Some(Value::String(text)) => Some(text.as_str().to_string()),
        _ => None,
    }
}
