use std::time::Duration;

use crate::prompt::Usage;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    /// The reference names no model of the person's endpoints; empty when none was chosen.
    #[error("{}", unknown_model(.0))]
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
        /// The HTTP status the endpoint refused it with; none when no answer came at all.
        status: Option<u16>,
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

/// A definite sign that a model can't serve a call now, the only kind a route falls back on
/// (ADR 0205 §2, ADR 0053). A slow answer, a bad answer or a refusal is never one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unserved {
    /// The request never reached it: connection refused, DNS or TLS failure.
    Unreachable,
    /// `429` for a rate limit.
    RateLimited,
    /// The account's quota or credit is used up.
    Quota,
    /// `5xx`; a route moves on only once the usual tries with backoff are used up.
    ServerError,
}

/// What a missing model says: that none is chosen yet, or that the chosen one is gone.
fn unknown_model(reference: &str) -> String {
    if reference.trim().is_empty() {
        "no model is chosen yet: choose one in Spade's settings, under Models".to_owned()
    } else {
        format!("{reference} is not a model on one of your endpoints")
    }
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

    /// Whether the endpoint may have billed the call: it answered (or failed in a way that
    /// can't rule that out). A request never sent, refused before any answer, or missing its
    /// key or model was never billed.
    pub fn may_have_billed(&self) -> bool {
        matches!(
            self,
            Self::Provider { .. } | Self::Empty { .. } | Self::Shape { .. }
        )
    }

    /// The definite sign this failure is, if it is one (see [`Unserved`]).
    pub fn unserved(&self) -> Option<Unserved> {
        let Self::Unanswered {
            status,
            transient,
            message,
            ..
        } = self
        else {
            return None;
        };
        match *status {
            None => Some(Unserved::Unreachable),
            Some(402) => Some(Unserved::Quota),
            Some(_) if crate::failure::used_up(message) => Some(Unserved::Quota),
            Some(429) if *transient => Some(Unserved::RateLimited),
            Some(429) => Some(Unserved::Quota),
            Some(500..=599) if *transient => Some(Unserved::ServerError),
            Some(_) => None,
        }
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
