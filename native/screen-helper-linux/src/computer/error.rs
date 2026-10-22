//! Engine failures. Messages are written for the model: they say what happened and what to do
//! next, and reach it unchanged.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CuError {
    pub code: &'static str,
    pub message: String,
}

impl CuError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CuError {}

pub type CuResult<T> = Result<T, CuError>;

pub const CANCELLED_MESSAGE: &str = "Stopped: the agent's turn was cancelled.";

pub fn cancelled() -> CuError {
    CuError::new("cancelled", CANCELLED_MESSAGE)
}

/// Clips text for a message or label: at most `limit` characters, with an ellipsis when cut.
/// Bidi marks (Calculator wraps numbers in them) are invisible noise and dropped.
pub fn clip(text: &str, limit: usize) -> Option<String> {
    let visible: String = text
        .chars()
        .take(limit * 4 + 64)
        .filter(|c| !matches!(*c as u32, 0x200E..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069))
        .collect();
    let trimmed = visible.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > limit {
        let cut: String = trimmed.chars().take(limit).collect();
        Some(format!("{cut}…"))
    } else {
        Some(trimmed.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::clip;

    #[test]
    fn clipping_drops_bidi_marks_and_marks_the_cut() {
        assert_eq!(clip("\u{200e}42\u{200f}", 10).as_deref(), Some("42"));
        assert_eq!(clip("abcdef", 3).as_deref(), Some("abc…"));
        assert_eq!(clip("   ", 3), None);
    }
}
