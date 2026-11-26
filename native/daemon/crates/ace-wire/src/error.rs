// SPDX-License-Identifier: Apache-2.0
//! Why a wire message was refused: the JSON, the envelope or the body, never a client.

/// What a socket could not accept, or could not write.
#[derive(Debug, thiserror::Error)]
pub enum WireError {
    /// Not JSON at all, so not a message.
    #[error("not JSON: {0}")]
    Json(String),
    /// JSON that is not an object, so it carries no `type`.
    #[error("a wire message must be a JSON object")]
    NotAnObject,
    /// An object with no string `type`.
    #[error("a wire message has no string `type`")]
    MissingType,
    /// A `type` no client or server union defines.
    #[error("unknown wire message type {type_}")]
    UnknownType { type_: String },
    /// A body its own type's shape refuses (the union decoded it as another message).
    #[error("{type_} is not shaped as that message")]
    Rejected { type_: String },
    /// A body the generated type could not decode.
    #[error("the body does not decode: {0}")]
    Body(String),
    /// A refinement Zod applies and JSON Schema cannot: the message parses but is invalid.
    #[error("{type_} breaks a rule the schema states: {rule}")]
    Refinement { type_: String, rule: &'static str },
}
