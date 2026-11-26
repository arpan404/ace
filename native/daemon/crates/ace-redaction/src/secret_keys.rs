// SPDX-License-Identifier: Apache-2.0
//! Secret-bearing names: the one test that decides whether a key's value must never be seen.
//!
//! This list is the owner for every Rust redaction path. It is `@ace/redaction`'s
//! `secret-keys.ts` (`packages/redaction/src/secret-keys.ts`) plus the OpenCode adapter's
//! words (`packages/adapter-opencode/src/redaction.ts`'s `secretKey`: `headers`, `settings`,
//! `providerState`, `resultState` and exactly `native`), so a key shape added for one caller
//! can never leak through another. `api.?key` is the adapter's spelling; it is wider than
//! `api[_-]?key` and therefore masks strictly more.
//!
//! The TypeScript adapter keeps its own list until the engine's TypeScript is deleted (the
//! owner's Rust-only rule, `docs/engine/behaviour.md` §20); this set is a superset of it, so
//! the Rust adapter redacts strictly more.

use regex::Regex;
use std::sync::LazyLock;

/// `token|secret|password|api.?key|authorization|cookie|credential|ticket|
/// pairing[_-]?code|encryptedContent|headers|settings|providerState|resultState|grant$|
/// ^standing$|proof$|^native$`, case-insensitive. Matching is unanchored (`RegExp.test`), so
/// `my_token` and `GH_TOKEN` are both secret; `native` is the one exact match.
#[allow(clippy::expect_used)]
static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)token|secret|password|api.?key|authorization|cookie|credential|ticket|pairing[_-]?code|encryptedContent|headers|settings|providerState|resultState|grant$|^standing$|proof$|^native$",
    )
    .expect("the secret-key pattern compiles")
});

/// Whether `key` names a secret.
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
            "apixkey",
            "authorization",
            "cookie",
            "credential",
            "ticket",
            "pairing_code",
            "encryptedContent",
            "headers",
            "settings",
            "providerState",
            "resultState",
            "grant",
            "standing",
            "proof",
            "native",
        ] {
            assert!(is_secret_key(key), "{key}");
        }
        for key in [
            "visible",
            "note",
            "grants",
            "proofs",
            "author",
            "nativeSessionId",
            "native_name",
            "headline",
            "setting",
        ] {
            assert!(!is_secret_key(key), "{key}");
        }
    }
}
