#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    #[error("{0} is not an endpoint/model in the catalogue")]
    UnknownModel(String),

    #[error("{var} is not set, so endpoint {endpoint} cannot be called")]
    MissingKey { endpoint: String, var: String },

    /// The HTTP client could not be built (TLS or proxy setup).
    #[error("model client setup failed: {0}")]
    Setup(String),

    /// The endpoint failed: network, auth, rate limit, bad request.
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
