// SPDX-License-Identifier: Apache-2.0
//! Credential helper sources from the person's own configuration
//! (`packages/git/src/credential-helpers.ts`, G2c): helpers and
//! `core.sshCommand` values from their system, XDG and global files only, never
//! from a file inside the checkout, its Git directory or a protected root.

use std::path::Path;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::core::spawn::BoxFuture;

pub mod sources;

pub use sources::{
    read_credential_helpers, read_ssh_commands, repository_ssh_commands,
    system_credential_config_file,
};

/// A credential helper exactly as Git names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialHelper {
    pub key: String,
    pub value: String,
}

/// One `git config` answer the checks read.
#[derive(Debug, Clone)]
pub struct ConfigOutput {
    pub stdout: Vec<u8>,
    pub exit_code: i32,
    pub truncated: bool,
}

/// The port that runs one `git config` query; every argument list is Git's own.
pub trait GitQuery: Send + Sync {
    fn query(&self, args: &[String]) -> BoxFuture<'_, Result<ConfigOutput, GitError>>;
}

pub(crate) fn malformed(message: &str) -> GitError {
    GitError::new(GitErrorCode::MalformedOutput, message)
}

/// The `-z` field values Git printed, refusing anything but a terminated listing.
pub fn values(output: &ConfigOutput) -> Result<Vec<String>, GitError> {
    if output.truncated {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            "Credential helper configuration is too large",
        ));
    }
    if output.exit_code != 0 && output.exit_code != 1 {
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            "Could not inspect user credential helper configuration",
        ));
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| {
        GitError::new(
            GitErrorCode::MalformedOutput,
            "Invalid credential helper configuration encoding",
        )
    })?;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if output.exit_code != 0 || !text.ends_with('\0') {
        return Err(malformed("Invalid credential helper configuration"));
    }
    Ok(text[..text.len() - 1]
        .split('\0')
        .map(str::to_owned)
        .collect())
}

/// Groups of `size` NUL-terminated fields, e.g. origin and value from `--show-origin`.
pub fn records(output: &ConfigOutput, size: usize) -> Result<Vec<Vec<String>>, GitError> {
    let fields = values(output)?;
    if size == 0 || !fields.len().is_multiple_of(size) {
        return Err(malformed("Invalid user transport configuration"));
    }
    Ok(fields.chunks(size).map(<[String]>::to_vec).collect())
}

/// Paths that may not supply transport programs, canonical.
pub struct TrustedOrigin {
    roots: Vec<Option<String>>,
}

impl TrustedOrigin {
    pub fn new(untrusted_roots: &[String]) -> Self {
        Self {
            roots: untrusted_roots
                .iter()
                .map(|root| paths::canonical(root).ok())
                .collect(),
        }
    }

    /// Whether `origin` is a file outside every untrusted root, following symbolic links.
    pub fn trusted(&self, origin: Option<&str>) -> bool {
        let Some(path) = origin.and_then(|origin| origin.strip_prefix("file:")) else {
            return false;
        };
        if !Path::new(path).is_absolute() {
            return false;
        }
        let Ok(resolved) = paths::canonical(path) else {
            return false;
        };
        let separator = std::path::MAIN_SEPARATOR;
        self.roots.iter().all(|root| match root {
            None => true,
            Some(root) => resolved != *root && !resolved.starts_with(&format!("{root}{separator}")),
        })
    }
}

/// The helper key's schema: `[^\0\n=]` refuses the `=` a `-c` key cannot carry.
pub(crate) fn helper_key_ok(key: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| regex::Regex::new(r"^credential\.(?:[^\x00\n=]+\.)?helper$").ok());
    // A zod bound counts code points; the key's is 4,096.
    key.chars().count() <= 4_096
        && pattern
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(key))
}

fn helper_value_ok(value: &str) -> bool {
    // The value's bound is 16,384 code points.
    value.chars().count() <= 16_384 && !value.contains('\0')
}

/// The array's own `Helpers` schema: at most 512 entries, each key and value in bounds.
pub fn validate_helpers(helpers: Vec<CredentialHelper>) -> Result<Vec<CredentialHelper>, GitError> {
    if helpers.len() > 512
        || helpers
            .iter()
            .any(|helper| !helper_key_ok(&helper.key) || !helper_value_ok(&helper.value))
    {
        return Err(malformed("Invalid user credential helper configuration"));
    }
    Ok(helpers)
}

/// Command configuration is read last: discard every inherited helper before restoring trust.
pub fn credential_helper_args(helpers: Vec<CredentialHelper>) -> Result<Vec<String>, GitError> {
    let mut args = vec![
        "-c".to_owned(),
        "credential.helper=".to_owned(),
        "-c".to_owned(),
        "core.askPass=".to_owned(),
    ];
    for helper in validate_helpers(helpers)? {
        args.push("-c".to_owned());
        args.push(format!("{}={}", helper.key, helper.value));
    }
    Ok(args)
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests;
