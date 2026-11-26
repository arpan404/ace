// SPDX-License-Identifier: Apache-2.0
//! Secret-bearing names (`packages/redaction/src/secret-keys.ts`): one test decides whether a
//! key's value must never be seen.

use regex::Regex;
use std::sync::LazyLock;

/// `token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|
/// pairing[_-]?code|encryptedContent|grant$|^standing$|proof$`, case-insensitive.
#[allow(clippy::expect_used)]
static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code|encryptedContent|grant$|^standing$|proof$",
    )
    .expect("the secret-key pattern compiles")
});

/// Whether `key` names a secret. Matching is unanchored (as `RegExp.test` is), so `my_token`
/// and `GH_TOKEN` are both secret.
pub fn is_secret_key(key: &str) -> bool {
    SECRET_KEY.is_match(key)
}

#[cfg(test)]
mod tests {
    use super::is_secret_key;

    #[test]
    fn credential_shaped_names_are_secret_and_ordinary_names_are_not() {
        for key in [
            "token",
            "GH_TOKEN",
            "accessToken",
            "refresh_token",
            "password",
            "api_key",
            "apiKey",
            "authorization",
            "cookie",
            "credential",
            "ticket",
            "pairing_code",
            "encryptedContent",
            "grant",
            "standing",
            "proof",
        ] {
            assert!(is_secret_key(key), "{key}");
        }
        for key in ["visible", "note", "grants", "proofs", "author"] {
            assert!(!is_secret_key(key), "{key}");
        }
    }
}
