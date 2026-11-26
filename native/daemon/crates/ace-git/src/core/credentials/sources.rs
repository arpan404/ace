// SPDX-License-Identifier: Apache-2.0
//! Helpers and `core.sshCommand` values from the person's own files, the repository's own SSH
//! command and the compiled system file (`credential-helpers.ts`, G2c).

use std::path::Path;

use crate::core::error::GitError;

use super::{
    CredentialHelper, GitQuery, TrustedOrigin, helper_key_ok, malformed, records, validate_helpers,
    values,
};

/// Helpers from one of the person's own config files, following its includes and `includeIf`
/// conditions (evaluated against the checkout the query runs in), as their own Git would.
pub async fn read_credential_helpers(
    query: &dyn GitQuery,
    file: &str,
    trusted: &TrustedOrigin,
) -> Result<Vec<CredentialHelper>, GitError> {
    // A single query preserves generic/URL-scoped helpers and empty resets in file order.
    let output = query
        .query(&config_file_args(
            file,
            &["--get-regexp", r"^credential\.(.*\.)?helper$"],
        ))
        .await?;
    let mut ordered: Vec<CredentialHelper> = Vec::new();
    for entry in records(&output, 2)? {
        let (origin, value) = match entry.as_slice() {
            [origin, value] => (origin, value),
            _ => return Err(malformed("Invalid credential helper configuration")),
        };
        let Some(separator) = value.find('\n') else {
            return Err(malformed("Invalid credential helper configuration"));
        };
        if trusted.trusted(Some(origin)) {
            ordered.push(CredentialHelper {
                key: value[..separator].to_owned(),
                value: value[separator + 1..].to_owned(),
            });
        }
    }
    validate_helpers(ordered)
}

/// `core.sshCommand` values from one of the person's own files, under the same trust rule.
pub async fn read_ssh_commands(
    query: &dyn GitQuery,
    file: &str,
    trusted: &TrustedOrigin,
) -> Result<Vec<String>, GitError> {
    let output = query
        .query(&config_file_args(file, &["--get-all", "core.sshCommand"]))
        .await?;
    Ok(records(&output, 2)?
        .into_iter()
        .filter(|entry| trusted.trusted(entry.first().map(String::as_str)))
        .filter_map(|entry| entry.get(1).cloned())
        .collect())
}

fn config_file_args(file: &str, tail: &[&str]) -> Vec<String> {
    let mut args = vec![
        "config".to_owned(),
        "--file".to_owned(),
        file.to_owned(),
        "--includes".to_owned(),
        "--show-origin".to_owned(),
        "--null".to_owned(),
    ];
    args.extend(tail.iter().map(|arg| (*arg).to_owned()));
    args
}

/// The repository's own `core.sshCommand` values (local and worktree scope), in Git's order.
pub async fn repository_ssh_commands(query: &dyn GitQuery) -> Result<Vec<String>, GitError> {
    let output = query
        .query(&[
            "config".to_owned(),
            "--show-scope".to_owned(),
            "--null".to_owned(),
            "--get-all".to_owned(),
            "core.sshCommand".to_owned(),
        ])
        .await?;
    Ok(records(&output, 2)?
        .into_iter()
        .filter(|entry| {
            matches!(
                entry.first().map(String::as_str),
                Some("local" | "worktree")
            )
        })
        .filter_map(|entry| entry.get(1).cloned())
        .collect())
}

/// Git's compiled system file, pinned to system scope with includes disabled. Found by any key a
/// transfer borrows from it (a credential helper or `core.sshCommand`); a system file setting
/// neither has nothing to restore.
pub async fn system_credential_config_file(
    query: &dyn GitQuery,
) -> Result<Option<String>, GitError> {
    let output = query
        .query(&[
            "config".to_owned(),
            "--system".to_owned(),
            "--no-includes".to_owned(),
            "--null".to_owned(),
            "--show-origin".to_owned(),
            "--name-only".to_owned(),
            "--get-regexp".to_owned(),
            r"^(credential\.(.*\.)?helper|core\.sshcommand)$".to_owned(),
        ])
        .await?;
    let entries = values(&output)?;
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let origin = entries.get(index).map(String::as_str);
        let key = entries.get(index + 1).map(String::as_str);
        index += 2;
        let (Some(origin), Some(key)) = (origin, key) else {
            return Err(malformed("Invalid system credential config origin"));
        };
        let path = origin
            .strip_prefix("file:")
            .filter(|path| !path.is_empty())
            .ok_or_else(|| malformed("Invalid system credential config origin"))?;
        if !(helper_key_ok(key) || key == "core.sshcommand") {
            return Err(malformed("Invalid system credential config origin"));
        }
        if !Path::new(path).is_absolute() {
            return Err(malformed("Invalid system credential config path"));
        }
        if !paths.iter().any(|known| known == path) {
            paths.push(path.to_owned());
        }
    }
    if paths.len() > 1 {
        return Err(malformed("Ambiguous system credential config origin"));
    }
    Ok(paths.into_iter().next())
}

#[cfg(test)]
mod tests;
