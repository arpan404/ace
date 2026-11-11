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
    /// The daemon could not be reached to open a session or list tools.
    #[error("ace's tools are unavailable: {0}")]
    Unavailable(String),
    /// The request never reached a tool: the daemon had closed the session (HTTP 404) or the
    /// connection was refused. A call that fails this way did not run; the next request opens a
    /// new session.
    #[error("the request was not run: {0}")]
    NotRun(String),
    /// The connection broke after a call was sent. It may or may not have run.
    #[error("the call may or may not have run: {0}")]
    OutcomeUnknown(String),
    /// No answer in time. For a call, it may or may not have run; ace was asked to cancel it.
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
        ServiceError::TransportSend(ref transport) => match http(transport.error.as_ref()) {
            Http::Refused => ToolsError::Refused,
            Http::NotRun(why) => ToolsError::NotRun(why.into()),
            Http::Other => ToolsError::Unavailable(token.scrub(chain(&error))),
        },
        ServiceError::TransportClosed => ToolsError::Unavailable(token.scrub(chain(&error))),
        other => ToolsError::Protocol(token.scrub(chain(&other))),
    }
}

pub(crate) fn from_init(error: ClientInitializeError, token: &Secret) -> ToolsError {
    match &error {
        ClientInitializeError::TransportError { error: inner, .. }
            if http(inner.error.as_ref()) == Http::Refused =>
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

#[derive(Debug, PartialEq, Eq)]
enum Http {
    Refused,
    NotRun(&'static str),
    Other,
}

/// What the HTTP layer saw. The SDK reports a challenge-less 401 or 403 (what the daemon sends)
/// only as text, `HTTP 401 Unauthorized…`, so that is matched too.
fn http(error: &(dyn StdError + 'static)) -> Http {
    let mut next = Some(error);
    while let Some(error) = next {
        if let Some(http) = error.downcast_ref::<StreamableHttpError<reqwest::Error>>() {
            return match http {
                StreamableHttpError::AuthRequired(_)
                | StreamableHttpError::InsufficientScope(_) => Http::Refused,
                StreamableHttpError::UnexpectedServerResponse(text)
                    if text.starts_with("HTTP 401") || text.starts_with("HTTP 403") =>
                {
                    Http::Refused
                }
                StreamableHttpError::SessionExpired => {
                    Http::NotRun("ace had closed Spade's session before the request arrived")
                }
                StreamableHttpError::Client(error) if error.is_connect() => {
                    Http::NotRun("could not connect to ace")
                }
                _ => Http::Other,
            };
        }
        next = error.source();
    }
    Http::Other
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
