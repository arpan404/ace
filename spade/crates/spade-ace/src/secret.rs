//! A credential that never prints. Error text built from outside messages is scrubbed of it too.

use std::fmt;

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    /// `text` with every copy of the secret replaced, for errors that quote a server or library.
    pub(crate) fn scrub(&self, text: impl Into<String>) -> String {
        let text = text.into();
        if self.0.is_empty() {
            return text;
        }
        text.replace(&self.0, "[redacted]")
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_shows_in_debug_or_scrubbed_text() {
        let secret = Secret::new("tok-123");
        assert!(!format!("{secret:?}").contains("tok-123"));
        assert_eq!(
            secret.scrub("bad tok-123 and tok-123"),
            "bad [redacted] and [redacted]"
        );
        assert_eq!(Secret::new("").scrub("left alone"), "left alone");
    }
}
