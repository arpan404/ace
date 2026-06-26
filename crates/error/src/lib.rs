use std::{error::Error, fmt, io};

pub type AceResult<T> = Result<T, AceError>;

#[derive(Debug)]
pub enum AceError {
    Io(io::Error), // for io related errors
    Json(serde_json::Error),
    Config(String),
    State(String),
    Provider(String), // for provider specific errors

    Message(String), // generic error message
}

impl fmt::Display for AceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AceError::Io(e) => write!(f, "IO error: {}", e),
            AceError::Json(e) => write!(f, "JSON error: {}", e),
            AceError::Config(e) => write!(f, "Config error: {}", e),
            AceError::State(e) => write!(f, "State error: {}", e),
            AceError::Provider(e) => write!(f, "Provider error: {}", e),
            AceError::Message(e) => write!(f, "{}", e),
        }
    }
}

impl Error for AceError {}

// allows ? to be used with AceError
impl From<io::Error> for AceError {
    fn from(e: io::Error) -> Self {
        AceError::Io(e)
    }
}

impl From<String> for AceError {
    fn from(e: String) -> Self {
        AceError::Message(e)
    }
}

impl From<serde_json::Error> for AceError {
    fn from(e: serde_json::Error) -> Self {
        AceError::Json(e)
    }
}
