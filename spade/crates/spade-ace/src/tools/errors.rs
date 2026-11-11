//! Turning SDK errors into `ToolsError`, with the token scrubbed from every message.

use std::error::Error as StdError;

use rmcp::ServiceError;
use rmcp::service::ClientInitializeError;
use rmcp::transport::streamable_http_client::StreamableHttpError;

use crate::secret::Secret;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ToolsError {
    /// The daemon refused the token (HTTP 401 or 403): it expired, was revoked, or ace restarted.
    #[error("ace refused Spade's tool credential")]
    Refused,
    /// The daemon could not be reached, or the session dropped before an answer came. A call
    /// that fails this way may or may not have run.
    #[error("ace's tools are unavailable: {0}")]
    Unavailable(String),
    #[error("ace did not answer in time")]
    Timeout,
    /// The daemon answered with a JSON-RPC error, such as an unknown tool or bad arguments.
    #[error("ace refused the request ({code}): {message}")]
    Server { code: i32, message: String },
    #[error("ace sent something Spade could not read: {0}")]
    Protocol(String),
    #[error("tool arguments must be a JSON object")]
    InvalidArguments,
}

pub(crate) fn from_service(error: ServiceError, token: &Secret) -> ToolsError {
    match error {
        ServiceError::McpError(data) => ToolsError::Server {
            code: data.code.0,
            message: token.scrub(data.message.to_string()),
        },
        ServiceError::Timeout { .. } => ToolsError::Timeout,
        ServiceError::TransportSend(ref transport) if refused(transport.error.as_ref()) => {
            ToolsError::Refused
        }
        ServiceError::TransportSend(_) | ServiceError::TransportClosed => {
            ToolsError::Unavailable(token.scrub(chain(&error)))
        }
        other => ToolsError::Protocol(token.scrub(chain(&other))),
    }
}

pub(crate) fn from_init(error: ClientInitializeError, token: &Secret) -> ToolsError {
    match &error {
        ClientInitializeError::TransportError { error: inner, .. }
            if refused(inner.error.as_ref()) =>
        {
            ToolsError::Refused
        }
        ClientInitializeError::JsonRpcError(data) => ToolsError::Server {
            code: data.code.0,
            message: token.scrub(data.message.to_string()),
        },
        _ => ToolsError::Unavailable(token.scrub(chain(&error))),
    }
}

/// Whether the HTTP layer saw 401 or 403. The SDK reports a challenge-less refusal (what the
/// daemon sends) only as text, `HTTP 401 Unauthorized: …`, so that is matched too.
fn refused(error: &(dyn StdError + 'static)) -> bool {
    let mut next = Some(error);
    while let Some(error) = next {
        if let Some(http) = error.downcast_ref::<StreamableHttpError<reqwest::Error>>() {
            return match http {
                StreamableHttpError::AuthRequired(_)
                | StreamableHttpError::InsufficientScope(_) => true,
                StreamableHttpError::UnexpectedServerResponse(text) => {
                    text.starts_with("HTTP 401") || text.starts_with("HTTP 403")
                }
                _ => false,
            };
        }
        next = error.source();
    }
    false
}

fn chain(error: &dyn StdError) -> String {
    let mut text = error.to_string();
    let mut next = error.source();
    while let Some(cause) = next {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        next = cause.source();
    }
    text
}
