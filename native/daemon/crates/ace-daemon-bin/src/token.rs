// SPDX-License-Identifier: Apache-2.0
//! The daemon token and this home's host id (`loadToken` and `loadHostId`,
//! `apps/daemon/src/local-files.ts:84`–`:145`).
//!
//! The token is 64 hex characters in `<home>/daemon-token`, created exclusively
//! with mode `0600` and set to `0600` on every start. The host id is a UUID in
//! `<home>/host-id`. Both are kept across runs, so a paired device's pin and a
//! client's token still match after a restart.
//!
//! TypeScript cases ported: `apps/daemon/src/local-files.test.ts` ("Windows holds
//! one daemon lock and keeps its token and host id across loads") and
//! `apps/daemon/src/local-token.test.ts` ("prints the token from the daemon's own
//! home, without the trailing newline", "a damaged token file is reported, never
//! printed" — the reader's half is the CLI's, the writer's format is proven here).

use std::io;
use std::path::{Path, PathBuf};

pub use ace_auth::valid_token;

/// Why the token could not be loaded.
#[derive(Debug)]
pub enum TokenError {
    /// The file exists but is not 64 lowercase hex characters.
    Invalid,
    /// It could not be created, read or restricted.
    Io { action: String, source: io::Error },
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("Invalid daemon token file"),
            Self::Io { action, source } => write!(formatter, "{action}: {source}"),
        }
    }
}

impl std::error::Error for TokenError {}

/// The daemon's host token and the file it lives in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub token: String,
    pub path: PathBuf,
}

/// `loadToken`: make the file when it is missing, restrict it, read it.
pub fn load(data_dir: &Path) -> Result<Token, TokenError> {
    let path = data_dir.join("daemon-token");
    match crate::home::create_private(
        &path,
        crate::ids::random_hex_32()
            .map_err(|error| TokenError::Io {
                action: "Cannot make the daemon token".to_owned(),
                source: io::Error::other(error.to_string()),
            })?
            .as_bytes(),
    ) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(source) => {
            return Err(TokenError::Io {
                action: "Cannot create the daemon token".to_owned(),
                source,
            });
        }
    }
    set_private(&path).map_err(|source| TokenError::Io {
        action: "Cannot restrict the daemon token".to_owned(),
        source,
    })?;
    // One reader with the CLI's (`local-token.ts` via `ace-auth`): it trims the
    // trailing newline a Bun-written home has, and a leading BOM, before checking
    // the 64 hex characters.
    match ace_auth::read_local_token(data_dir) {
        Ok(token) => Ok(Token { token, path }),
        Err(error) => Err(token_error(error)),
    }
}

/// `loadHostId`: `<home>/host-id`, made on first start and kept after.
pub fn load_host_id(data_dir: &Path) -> Result<String, TokenError> {
    let path = data_dir.join("host-id");
    match crate::ids::uuid_v4() {
        Ok(id) => match crate::home::create_private(&path, id.as_bytes()) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(source) => {
                return Err(TokenError::Io {
                    action: "Cannot create the host id".to_owned(),
                    source,
                });
            }
        },
        Err(error) => {
            return Err(TokenError::Io {
                action: "Cannot make the host id".to_owned(),
                source: io::Error::other(error.to_string()),
            });
        }
    }
    std::fs::read_to_string(&path).map_err(|source| TokenError::Io {
        action: "Cannot read the host id".to_owned(),
        source,
    })
}

/// `ace-auth`'s refusal, said in the daemon's own words: a file that is there but
/// not a token is "Invalid daemon token file", and anything else keeps its cause.
fn token_error(error: ace_auth::AuthError) -> TokenError {
    match error {
        ace_auth::AuthError::Token(message) if message.contains("not valid") => TokenError::Invalid,
        ace_auth::AuthError::Token(message) => TokenError::Io {
            action: "Cannot read the daemon token".to_owned(),
            source: io::Error::other(message),
        },
        other => TokenError::Io {
            action: "Cannot read the daemon token".to_owned(),
            source: io::Error::other(other.to_string()),
        },
    }
}

/// `chmodSync(path, 0o600)`.
#[cfg(unix)]
fn set_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `local-files.test.ts`: "Windows holds one daemon lock and keeps its token and
    /// host id across loads" — the token and host id are kept on every platform.
    #[test]
    fn the_token_and_host_id_are_kept_across_loads() {
        let home = TempDir::new("ace-token");
        let first = load(home.path());
        assert!(first.is_ok(), "a fresh home gets a token");
        let Ok(first) = first else { return };
        assert_eq!(first.token.len(), 64);
        assert!(
            first
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "64 lowercase hex characters"
        );
        let second = load(home.path());
        assert_eq!(
            second.ok().map(|token| token.token),
            Some(first.token.clone())
        );
        let host = load_host_id(home.path());
        assert!(host.is_ok(), "a fresh home gets a host id");
        assert_eq!(load_host_id(home.path()).ok(), host.ok());
    }

    /// The token file's mode is `0600` on Unix, on creation and after.
    #[test]
    #[cfg(unix)]
    fn the_token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let home = TempDir::new("ace-token-mode");
        assert!(load(home.path()).is_ok());
        let mode = std::fs::metadata(home.path().join("daemon-token"))
            .map(|m| m.permissions().mode())
            .unwrap_or(0);
        assert_eq!(mode & 0o777, 0o600);
    }

    /// `local-token.test.ts`: "prints the token from the daemon's own home,
    /// without the trailing newline": a home the Bun daemon wrote has one, and
    /// this reader must accept it.
    #[test]
    fn a_token_file_with_a_trailing_newline_or_bom_loads() {
        let token = "ab".repeat(32);
        for written in [
            format!("{token}\n"),
            format!("\u{feff}{token}\n"),
            format!("  {token}  \r\n"),
        ] {
            let home = TempDir::new("ace-token-bun");
            let _ = std::fs::write(home.path().join("daemon-token"), &written);
            let loaded = load(home.path());
            assert_eq!(
                loaded.ok().map(|token| token.token),
                Some(token.clone()),
                "{written:?}"
            );
        }
    }

    /// `local-token.test.ts`: "a damaged token file is reported, never printed".
    #[test]
    fn a_damaged_token_file_is_refused_and_kept() {
        let home = TempDir::new("ace-token-damaged");
        let path = home.path().join("daemon-token");
        let _ = std::fs::write(&path, "not-a-token");
        let error = load(home.path()).err();
        assert_eq!(
            error.map(|error| error.to_string()),
            Some("Invalid daemon token file".to_owned())
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap_or_default(),
            "not-a-token"
        );
    }

    /// `validToken`: only the exact 64 hex characters match; wrong lengths never do.
    #[test]
    fn only_the_exact_token_matches() {
        let token = "ab".repeat(32);
        assert!(valid_token(&token, &token));
        assert!(!valid_token(&format!("{token}0"), &token));
        assert!(!valid_token("ab", &token));
        assert!(!valid_token(&"cd".repeat(32), &token));
        assert!(!valid_token(&token, "short"));
    }
}
