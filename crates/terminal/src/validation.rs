use crate::{
    DEFAULT_TERMINAL_ID, Result, TerminalEnvVar, TerminalError,
    config::{
        MAX_COLS, MAX_ENV_KEY, MAX_ENV_KEYS, MAX_ENV_VALUE, MAX_ROWS, MAX_TERMINAL_ID,
        MAX_THREAD_ID, MIN_COLS, MIN_ROWS,
    },
};
use ace_project::WorkspaceService;
use std::path::PathBuf;

pub(crate) fn validate_thread_id(value: String) -> Result<String> {
    validate_id("thread_id", value, MAX_THREAD_ID)
}

pub(crate) fn validate_terminal_id(value: String) -> Result<String> {
    let value = if value.trim().is_empty() {
        DEFAULT_TERMINAL_ID.to_string()
    } else {
        value
    };
    validate_id("terminal_id", value, MAX_TERMINAL_ID)
}

pub(crate) fn validate_cols(value: u16) -> Result<u16> {
    if !(MIN_COLS..=MAX_COLS).contains(&value) {
        return Err(TerminalError::InvalidInput(format!(
            "cols must be {MIN_COLS}..={MAX_COLS}"
        )));
    }
    Ok(value)
}

pub(crate) fn validate_rows(value: u16) -> Result<u16> {
    if !(MIN_ROWS..=MAX_ROWS).contains(&value) {
        return Err(TerminalError::InvalidInput(format!(
            "rows must be {MIN_ROWS}..={MAX_ROWS}"
        )));
    }
    Ok(value)
}

pub(crate) fn validate_env(env: Vec<TerminalEnvVar>) -> Result<Vec<(String, String)>> {
    if env.len() > MAX_ENV_KEYS {
        return Err(TerminalError::InvalidInput(format!(
            "env supports at most {MAX_ENV_KEYS} keys"
        )));
    }
    env.into_iter()
        .map(|entry| {
            if !is_valid_env_key(&entry.key) || entry.key.len() > MAX_ENV_KEY {
                return Err(TerminalError::InvalidInput(format!(
                    "invalid env key: {}",
                    entry.key
                )));
            }
            if entry.value.len() > MAX_ENV_VALUE {
                return Err(TerminalError::InvalidInput(format!(
                    "env value for {} is too large",
                    entry.key
                )));
            }
            Ok((entry.key, entry.value))
        })
        .collect()
}

pub(crate) fn validate_cwd(cwd: &str) -> Result<PathBuf> {
    WorkspaceService::normalize_workspace_root(cwd, false)
        .map_err(|error| TerminalError::InvalidCwd(error.to_string()))
}

pub(crate) fn title_from_input(bytes: &[u8]) -> Option<String> {
    if !bytes.ends_with(b"\n") && !bytes.ends_with(b"\r") {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let command = text.trim();
    if command.is_empty() {
        return None;
    }
    Some(
        command
            .split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(80)
            .collect(),
    )
}

fn validate_id(name: &str, value: String, max: usize) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max {
        return Err(TerminalError::InvalidInput(format!(
            "{name} must be 1..={max} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn is_valid_env_key(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|char| char == '_' || char.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_dimensions_and_env() {
        assert!(validate_cols(19).is_err());
        assert!(validate_rows(201).is_err());
        assert!(
            validate_env(vec![TerminalEnvVar {
                key: "1BAD".to_string(),
                value: "x".to_string(),
            }])
            .is_err()
        );
    }
}
