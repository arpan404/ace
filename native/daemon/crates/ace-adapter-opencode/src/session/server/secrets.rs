// SPDX-License-Identifier: Apache-2.0
//! The two bounds a server's declaration answers for: `ServerSecrets.parse`
//! (`server.ts:144`-`:152`) and the 128-session join limit (`:148`-`:156`).

use super::super::error::SecretError;
use super::{MAX_SECRET_CHARS, MAX_SECRETS};

/// `ServerSecrets.parse` over one list, in the same order and with the same
/// code-point bounds (rule 17).
pub(super) fn check_secrets(secrets: &[String]) -> Result<(), SecretError> {
    if secrets.len() > MAX_SECRETS {
        return Err(SecretError::TooMany);
    }
    if secrets
        .iter()
        .any(|secret| secret.is_empty() || secret.chars().count() > MAX_SECRET_CHARS)
    {
        return Err(SecretError::Length);
    }
    Ok(())
}

/// Why a tenant could not join: "OpenCode session limit reached".
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("OpenCode session limit reached")]
pub struct SubscribeError;
