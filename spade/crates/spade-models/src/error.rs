use crate::gateway::Gateway;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    #[error("{0} is not in Spade's model catalogue")]
    UnknownModel(String),

    #[error("{gateway} cannot run {model}")]
    NoRoute { model: String, gateway: Gateway },

    #[error("the model catalogue sets no defaults for {0}")]
    NoDefaults(Gateway),

    #[error("SPADE_MODEL_GATEWAY must be openrouter, opencode-go or anthropic, got {0:?}")]
    UnknownGateway(String),

    /// The HTTP client could not be built (TLS or proxy setup).
    #[error("model client setup failed: {0}")]
    Setup(String),

    #[error("{0} is not set")]
    MissingKey(&'static str),

    /// The gateway or provider failed: network, auth, rate limit, bad request.
    #[error("{model}: {message}")]
    Provider { model: String, message: String },

    #[error("{model} returned no text")]
    Empty { model: String },

    /// Typed output did not match the requested type. Never patched up.
    #[error("{model} returned output that does not match {type_name}: {reason}")]
    Shape {
        model: String,
        type_name: &'static str,
        reason: String,
    },
}
