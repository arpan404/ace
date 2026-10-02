use serde::Serialize;
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    PermissionDenied,
    TargetGone,
    NotSupported,
    Bounds,
    Busy,
    Timeout,
    Internal,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Error {
    pub code: Code,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into().chars().take(1024).collect(),
        }
    }
    pub fn hresult(value: i32, message: impl Into<String>) -> Self {
        let code = match value as u32 {
            0x80070005 => Code::PermissionDenied,
            0x80040201 | 0x80070578 | 0x80070490 => Code::TargetGone,
            0x80004001 | 0x80004002 | 0x80040204 => Code::NotSupported,
            0x80070057 => Code::Bounds,
            0x8001010A | 0x800700AA => Code::Busy,
            0x800705B4 | 0x8001011F | 0x80131505 => Code::Timeout,
            _ => Code::Internal,
        };
        Self::new(code, message)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
#[cfg(windows)]
impl From<::windows::core::Error> for Error {
    fn from(error: ::windows::core::Error) -> Self {
        Self::hresult(error.code().0, error.to_string())
    }
}
