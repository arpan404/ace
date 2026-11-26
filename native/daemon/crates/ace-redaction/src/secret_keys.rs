// SPDX-License-Identifier: Apache-2.0
//! Secret-bearing names: the two key policies the Rust redaction paths use.
//!
//! There are two TypeScript lists, and this module owns both by name, so no shape can be
//! fixed in one place and leak in the other. Neither is the union of both: a counter named
//! `tokens` is usage, not a credential, and the adapter policy must keep it.
//!
//! - [`is_secret_key`] is `@ace/redaction`'s `secret-keys.ts`
//!   (`packages/redaction/src/secret-keys.ts`) exactly, and is what [`crate::Redactor`], the
//!   environment filter and the JSON credential scanner use.
//! - [`is_opencode_secret_key`] is the OpenCode adapter's `secretKey`
//!   (`packages/adapter-opencode/src/redaction.ts`) exactly: it adds `headers`, `settings`,
//!   `providerState`, `resultState` and exactly `native`, widens `api[_-]?key` to `api.?key`,
//!   and has no bare `token`, so `tokens`/`inputTokens` survive.

use regex::Regex;
use std::sync::LazyLock;

/// `@ace/redaction`'s list: `token|secret|password|api[_-]?key|authorization|cookie|
/// credential|ticket|pairing[_-]?code|encryptedContent|grant$|^standing$|proof$`,
/// case-insensitive and unanchored (`RegExp.test`).
#[allow(clippy::expect_used)]
static DEFAULT_SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code|encryptedContent|grant$|^standing$|proof$",
    )
    .expect("the default secret-key pattern compiles")
});

/// The OpenCode adapter's list: `authorization|password|cookie|api.?key|credential|
/// access.?token|refresh.?token|headers|settings|providerState|resultState|encryptedContent|
/// ^native$`, case-insensitive and unanchored.
#[allow(clippy::expect_used)]
static OPENCODE_SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)authorization|password|cookie|api.?key|credential|access.?token|refresh.?token|headers|settings|providerState|resultState|encryptedContent|^native$",
    )
    .expect("the OpenCode secret-key pattern compiles")
});

/// Whether `key` is a secret under `@ace/redaction`'s policy (the default).
pub fn is_secret_key(key: &str) -> bool {
    DEFAULT_SECRET_KEY.is_match(key)
}

/// Whether `key` is a secret under the OpenCode adapter's policy: its own narrower list, which
/// keeps token counters (`tokens`, `inputTokens`) readable so usage and context facts survive.
pub fn is_opencode_secret_key(key: &str) -> bool {
    OPENCODE_SECRET_KEY.is_match(key)
}

#[cfg(test)]
mod tests {
    use super::{is_opencode_secret_key, is_secret_key};

    /// `packages/redaction/src/secret-keys.ts`, word for word: `tokens` matches its bare
    /// `token`, `api.key` does not, and the adapter's extra words are not in it.
    #[test]
    fn the_default_policy_is_at_ace_redactions_list() {
        for key in [
            "token",
            "tokens",
            "GH_TOKEN",
            "accessToken",
            "refresh_token",
            "password",
            "api_key",
            "apiKey",
            "api-key",
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
        for key in [
            "visible",
            "note",
            "grants",
            "proofs",
            "author",
            "api.key",
            "headers",
            "settings",
            "providerState",
            "resultState",
            "native",
            "nativeSessionId",
        ] {
            assert!(!is_secret_key(key), "{key}");
        }
    }

    /// `packages/adapter-opencode/src/redaction.ts`'s `secretKey`, word for word: no bare
    /// `token` (so `tokens` and `inputTokens` are usage), and exactly `native`.
    #[test]
    fn the_opencode_policy_is_the_adapters_list() {
        for key in [
            "authorization",
            "password",
            "cookie",
            "apiKey",
            "api-key",
            "api.key",
            "credential",
            "access_token",
            "refreshToken",
            "headers",
            "settings",
            "providerState",
            "resultState",
            "encryptedContent",
            "native",
        ] {
            assert!(is_opencode_secret_key(key), "{key}");
        }
        for key in [
            "tokens",
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "token",
            "secret",
            "ticket",
            "grant",
            "visible",
            "nativeSessionId",
            "native_name",
        ] {
            assert!(!is_opencode_secret_key(key), "{key}");
        }
    }
}
