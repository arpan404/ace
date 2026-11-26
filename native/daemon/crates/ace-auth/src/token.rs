// SPDX-License-Identifier: Apache-2.0
//! The daemon token: the 64-hex secret a client on this machine pastes (`local-token.ts`), and
//! the constant-time comparison every local credential goes through (`local-files.ts:177`).

use std::path::Path;

use subtle::ConstantTimeEq;

use crate::error::{AuthError, Result};

/// Whether `text` is exactly a 64-character lowercase hex token (`/^[0-9a-f]{64}$/`).
pub fn is_token(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 64
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// The host token comparison (`local-files.ts:177`–`:185`): a 64-byte buffer is filled from the
/// presentation and compared in constant time, and the presentation's own length must be 64.
/// `expected` is the token file's value, which startup has already validated.
pub fn valid_token(actual: &str, expected: &str) -> bool {
    let mut padded = [0u8; 64];
    let presented = actual.as_bytes();
    let kept = presented.len().min(64);
    padded[..kept].copy_from_slice(&presented[..kept]);
    let mut want = [0u8; 64];
    let expected_bytes = expected.as_bytes();
    let want_kept = expected_bytes.len().min(64);
    want[..want_kept].copy_from_slice(&expected_bytes[..want_kept]);
    let equal: bool = padded.ct_eq(&want).into();
    equal && presented.len() == 64 && expected_bytes.len() == 64
}

/// The token a client pastes to connect (`ace token`), read from the home the daemon uses.
/// Errors keep the TypeScript's wording: a missing file tells the person to start the daemon,
/// and a damaged one is reported, never printed.
pub fn read_local_token(data_dir: &Path) -> Result<String> {
    let path = data_dir.join("daemon-token");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AuthError::Token(format!(
                "No daemon token at {} yet. Start the daemon with `ace start` first.",
                path.display()
            )));
        }
        Err(error) => return Err(AuthError::Token(error.to_string())),
    };
    let token =
        text.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if !is_token(token) {
        return Err(AuthError::Token(format!(
            "The daemon token at {} is not valid.",
            path.display()
        )));
    }
    Ok(token.to_owned())
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/local-token.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{is_token, read_local_token, valid_token};
    use crate::error::AuthError;

    #[test]
    fn prints_the_token_from_the_daemon_home_without_the_trailing_newline() {
        let directory = tempfile::tempdir().unwrap();
        let token = "ab".repeat(32);
        std::fs::write(directory.path().join("daemon-token"), format!("{token}\n")).unwrap();
        assert_eq!(read_local_token(directory.path()).unwrap(), token);
    }

    #[test]
    fn before_the_daemon_has_ever_started_says_to_start_it() {
        let directory = tempfile::tempdir().unwrap();
        let error = read_local_token(directory.path()).unwrap_err();
        match error {
            AuthError::Token(message) => assert!(
                message.contains("Start the daemon with `ace start`"),
                "{message}"
            ),
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn a_damaged_token_file_is_reported_never_printed() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("daemon-token"), "not-a-token").unwrap();
        let error = read_local_token(directory.path()).unwrap_err();
        match error {
            AuthError::Token(message) => {
                assert!(message.contains("not valid"), "{message}");
                assert!(!message.contains("not-a-token"), "{message}");
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn the_comparison_needs_exactly_sixty_four_lowercase_hex_characters() {
        let token = "ab".repeat(32);
        assert!(is_token(&token));
        assert!(valid_token(&token, &token));
        // A prefix followed by extra bytes is not the token (`auth.server.process.test.ts`).
        assert!(!valid_token(&format!("{token}suffix"), &token));
        assert!(!valid_token(&token[..63], &token));
        assert!(!is_token(&"AB".repeat(32)));
        // Each differing byte is a mismatch, not a throw.
        let mut other = token.clone().into_bytes();
        other[10] = b'c';
        assert!(!valid_token(std::str::from_utf8(&other).unwrap(), &token));
    }
}
