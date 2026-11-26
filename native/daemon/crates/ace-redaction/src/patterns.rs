// SPDX-License-Identifier: Apache-2.0
//! The credential-pattern list (`packages/redaction/src/credential-patterns.ts` and
//! `quoted-assignments.ts`), mirrored pattern for pattern and in the TypeScript's order.
//!
//! `prefix` names the capture group holding the syntax around a URL parameter's value, which
//! the lexical redactor keeps; `suffix` trims units from a match's end. Rust's `\b` is
//! Unicode-aware where JavaScript's is ASCII-only; the CLI text these patterns see is ASCII
//! around every token shape.

use regex::Regex;
use std::sync::LazyLock;

/// One credential spelling.
pub struct CredentialPattern {
    pub pattern: Regex,
    /// The capture group holding a syntactic prefix the redactor keeps (`#code=`).
    pub prefix: Option<usize>,
    /// Units trimmed from the match's end.
    pub suffix: usize,
}

impl CredentialPattern {
    #[allow(clippy::expect_used)]
    fn new(pattern: &str) -> CredentialPattern {
        CredentialPattern {
            pattern: Regex::new(pattern).expect("a credential pattern compiles"),
            prefix: None,
            suffix: 0,
        }
    }
}

/// The patterns, in the TypeScript list's order.
#[allow(clippy::expect_used)]
static PATTERNS: LazyLock<Vec<CredentialPattern>> = LazyLock::new(|| {
    let mut patterns = vec![
        CredentialPattern::new(r"\bAIza[A-Za-z0-9_-]{35}"),
        CredentialPattern::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
        CredentialPattern::new(r"\bnpm_[A-Za-z0-9]{20,}"),
        CredentialPattern::new(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"),
        CredentialPattern::new(r"\bgithub_pat_[A-Za-z0-9_]{16,}"),
        CredentialPattern::new(r"\bAKIA[A-Z0-9]{16}\b"),
        CredentialPattern::new(r"\bsk-[A-Za-z0-9_-]{16,}"),
        CredentialPattern::new(r"\bgh[opsur]_[A-Za-z0-9]{20,}"),
        CredentialPattern::new(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
        // ace account grants (ADR 0111, ADR 0190): signed JSON claims and a signature, two parts.
        CredentialPattern::new(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{43,}"),
        CredentialPattern::new(r"\bace\.grant\.[A-Za-z0-9_.-]+"),
        CredentialPattern::new(r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+"),
        // The entire quoted value is consumed, including whitespace, before bare assignments.
        CredentialPattern::new(
            r#"(?i)\b(?:token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code)\s*[=:]\s*(?:"(?:[^"\\]|\\[\s\S]?)*(?:"|$)|'(?:[^'\\]|\\[\s\S]?)*(?:'|$))"#,
        ),
        CredentialPattern::new(r"(?i)\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+"),
        CredentialPattern {
            pattern: Regex::new(r"(?i)([#&](?:code|ticket|token)=)[^&#\s]+")
                .expect("the URL parameter pattern compiles"),
            prefix: Some(0),
            suffix: 0,
        },
    ];
    patterns.shrink_to_fit();
    patterns
});

/// The patterns, for the lexical redactor.
pub fn patterns() -> &'static [CredentialPattern] {
    &PATTERNS
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::patterns;

    fn masked(input: &str) -> bool {
        patterns()
            .iter()
            .any(|pattern| pattern.pattern.is_match(input))
    }

    #[test]
    fn every_token_shape_the_type_script_recognises_is_matched() {
        for token in [
            "AIzaSyA1234567890123456789012345678901234",
            "xoxb-1234567890",
            "npm_12345678901234567890",
            "sk_live_1234567890123456",
            "github_pat_1234567890123456",
            "AKIA1234567890ABCDEF",
            "ghp_12345678901234567890",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            "ace.grant.abc.def",
        ] {
            assert!(masked(token), "{token}");
        }
        assert!(masked("authorization: Bearer abcdefghijklmnopqrstuvwxyz"));
        assert!(masked("token=opaque-value"));
        assert!(masked(r#"password="opaque value""#));
        assert!(masked("api_key=opaque-value"));
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        for text in [
            "ordinary prose about tokens",
            "an uppercase word",
            "note: authorization is required",
        ] {
            assert!(
                !patterns()
                    .iter()
                    .any(|pattern| pattern.pattern.is_match(text)),
                "{text}"
            );
        }
    }
}
