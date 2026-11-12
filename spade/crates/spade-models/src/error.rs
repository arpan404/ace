use std::time::Duration;

use crate::prompt::Usage;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    #[error("{0} is not a model on one of your endpoints")]
    UnknownModel(String),

    /// The endpoint's model list could not be read. One short line, never the key.
    #[error("{endpoint}: {message}")]
    Listing { endpoint: String, message: String },

    #[error("endpoint {endpoint} has no key: add one in Spade's settings{}", var.as_ref().map(|v| format!(" or set {v}")).unwrap_or_default())]
    MissingKey {
        endpoint: String,
        var: Option<String>,
    },

    /// The HTTP client could not be built (TLS or proxy setup).
    #[error("model client setup failed: {0}")]
    Setup(String),

    /// The endpoint failed: network, auth, rate limit, bad request.
    #[error("{model}: {message}")]
    Provider { model: String, message: String },

    /// The endpoint never answered: the request could not be sent, or it was refused with an
    /// HTTP error before anything streamed. Nothing was billed. `transient` failures (the
    /// network, `408`, `429`, `5xx`) may succeed if sent again, after `retry_after` when the
    /// endpoint named a wait.
    #[error("{model}: {message}")]
    Unanswered {
        model: String,
        message: String,
        transient: bool,
        retry_after: Option<Duration>,
    },

    /// The endpoint answered (and charged for it) but sent nothing usable.
    #[error("{model} returned no text")]
    Empty { model: String, usage: Usage },

    /// Typed output did not match the requested type. Never patched up.
    #[error("{model} returned output that does not match {type_name}: {reason}")]
    Shape {
        model: String,
        type_name: &'static str,
        reason: String,
        /// What the call that produced the output cost.
        usage: Usage,
    },
}

impl ModelError {
    /// Tokens the endpoint charged for a call that still failed, so it can be paid for.
    pub fn usage(&self) -> Option<Usage> {
        match self {
            Self::Empty { usage, .. } | Self::Shape { usage, .. } => Some(*usage),
            _ => None,
        }
    }

    /// Whether sending the same request again may succeed: it never reached a model, and the
    /// failure was the network's or the endpoint's passing state, not the request's.
    pub fn transient(&self) -> bool {
        matches!(
            self,
            Self::Unanswered {
                transient: true,
                ..
            }
        )
    }

    /// How long the endpoint asked to wait before sending again (`retry-after`).
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Unanswered { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    fn charged(self, cost: Usage) -> Self {
        match self {
            Self::Empty { model, .. } => Self::Empty { model, usage: cost },
            Self::Shape {
                model,
                type_name,
                reason,
                ..
            } => Self::Shape {
                model,
                type_name,
                reason,
                usage: cost,
            },
            other => other,
        }
    }
}

/// Attaches what a failed call cost to its error.
pub(crate) fn charged(error: ModelError, usage: Usage) -> ModelError {
    error.charged(usage)
}
