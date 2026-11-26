// SPDX-License-Identifier: Apache-2.0
//! The daemon's configuration, read exactly as `apps/daemon/src/config.ts` reads
//! it: the same variables, the same defaults and the same refusals.
//!
//! Ported from `readConfig` (`config.ts:170`–`:233`) and the `Environment`
//! schema above it. The TypeScript cases that pin the naming are
//! `apps/daemon/src/config-ace-client.test.ts` ("names a released daemon by its
//! version, beta prerelease included", "names a daemon run without a version a
//! development build", "sends no name for a version it can't read rather than
//! misnaming itself"); the remaining cases here are the refusals the schema
//! gives, which no TypeScript test file names.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

mod parse;
#[cfg(test)]
mod tests;

pub use parse::ace_client_name;
use parse::{
    absolute_url, account_origin, bounded, non_empty, number, parse_byte_size, path_value, port,
    positive, push_gateway, switch, web_origins,
};

/// The process environment, as pairs, so tests never touch the real one.
#[derive(Debug, Clone, Default)]
pub struct Env {
    values: BTreeMap<String, String>,
}

impl Env {
    /// This process's environment. A variable that is not valid Unicode is
    /// carried lossily, as the daemon's configuration is text.
    pub fn from_process() -> Self {
        let mut values = BTreeMap::new();
        for (name, value) in std::env::vars_os() {
            values.insert(
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
        Self { values }
    }

    /// An environment made of exactly these pairs.
    #[cfg(test)]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        let mut values = BTreeMap::new();
        for (name, value) in pairs {
            values.insert((*name).to_owned(), (*value).to_owned());
        }
        Self { values }
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
}

/// `ACE_LISTEN`: where clients may reach the daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listen {
    Local,
    Lan,
    Tailscale,
}

/// `ACE_LOG_LEVEL`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Silent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub variable: &'static str,
    pub message: String,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.variable, self.message)
    }
}

impl std::error::Error for ConfigError {}

fn invalid(variable: &'static str, message: impl Into<String>) -> ConfigError {
    ConfigError {
        variable,
        message: message.into(),
    }
}

/// What this start needs, in the shape `index.ts` uses it.
#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub port: u16,
    pub remote_port: u16,
    pub listen: Listen,
    pub web_origins: Vec<String>,
    pub log_level: LogLevel,
    pub safe_mode: bool,
    /// `ACE_VERSION`, or `development` for a build run without one.
    pub version: String,
    /// `ace-client` (`daemon/<version>`), ADR 0189: none for a version it can't read.
    pub ace_client: Option<String>,
    /// `ACE_MAINTENANCE=1`: a restart in the middle of an update.
    pub maintenance: bool,
}

/// `readConfig(env, home)`: validate every variable, then build the config.
pub fn read(env: &Env, home: &Path) -> Result<Config, ConfigError> {
    let local_port = port(env, "ACE_PORT")?.unwrap_or(4242);
    let remote_port = match port(env, "ACE_REMOTE_PORT")? {
        Some(remote) => remote,
        None if local_port == 0 || local_port == u16::MAX => 0,
        None => local_port + 1,
    };
    let listen = match env.get("ACE_LISTEN") {
        None => Listen::Local,
        Some("local") => Listen::Local,
        Some("lan") => Listen::Lan,
        Some("tailscale") => Listen::Tailscale,
        Some(other) => {
            return Err(invalid(
                "ACE_LISTEN",
                format!("expected local, lan or tailscale, not {other}"),
            ));
        }
    };
    let log_level = match env.get("ACE_LOG_LEVEL") {
        None => LogLevel::Info,
        Some("debug") => LogLevel::Debug,
        Some("info") => LogLevel::Info,
        Some("warn") => LogLevel::Warn,
        Some("error") => LogLevel::Error,
        Some("silent") => LogLevel::Silent,
        Some(other) => {
            return Err(invalid(
                "ACE_LOG_LEVEL",
                format!("expected debug, info, warn, error or silent, not {other}"),
            ));
        }
    };
    let safe_mode = switch(env, "ACE_SAFE_MODE")?;
    let _chrome_no_sandbox = switch(env, "ACE_CHROMIUM_NO_SANDBOX")?;
    let _helper_inherit = switch(env, "ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY")?;
    // Variables this slice validates but does not yet use: a later slice reads
    // them, and a start must refuse exactly what the TypeScript refuses.
    let _screen_helper = path_value(env, "ACE_SCREEN_HELPER")?;
    let _screen_helper_manifest = path_value(env, "ACE_SCREEN_HELPER_MANIFEST")?;
    let _cu_timings = non_empty(env, "ACE_CU_TIMINGS")?;
    let _chromium_path = non_empty(env, "ACE_CHROMIUM_PATH")?;
    let _cursor_sdk_home = non_empty(env, "ACE_CURSOR_SDK_HOME")?;
    let _attachment_file = positive(env, "ACE_ATTACHMENT_FILE_BYTES")?;
    let _attachment_message = positive(env, "ACE_ATTACHMENT_MESSAGE_BYTES")?;
    let _provider_idle = bounded(env, "ACE_PROVIDER_IDLE_SECONDS", 0, 86_400)?;
    let _worktree_timeout = bounded(
        env,
        "ACE_WORKTREE_PREPARATION_TIMEOUT_MS",
        60_000,
        3_600_000,
    )?;
    if let Some(value) = env.get("ACE_RETENTION_DAYS") {
        let days = number("ACE_RETENTION_DAYS", value)?;
        if days.fract() != 0.0 || !(1.0..=3650.0).contains(&days) {
            return Err(invalid(
                "ACE_RETENTION_DAYS",
                "expected a whole number of days from 1 to 3650",
            ));
        }
    }
    let _log_max_bytes = match env.get("ACE_LOG_MAX_BYTES") {
        None => None,
        Some(value) => {
            let bytes = parse_byte_size(value).ok_or_else(|| {
                invalid(
                    "ACE_LOG_MAX_BYTES",
                    "Use a size such as 1g, 512m or 1048576",
                )
            })?;
            if !(1_048_576..=64 * 1024 * 1024 * 1024).contains(&bytes) {
                return Err(invalid(
                    "ACE_LOG_MAX_BYTES",
                    "expected a size from 1 MiB to 64 GiB",
                ));
            }
            Some(bytes)
        }
    };
    for name in ["ACE_RELAY_URL", "ACE_MARKET_URL"] {
        if let Some(value) = env.get(name) {
            absolute_url(name, value)?;
        }
    }
    let account_url = match env.get("ACE_ACCOUNT_URL") {
        None => None,
        Some(value) => {
            account_origin(value)?;
            Some(value.to_owned())
        }
    };
    let hosted_relay = match env.get("ACE_HOSTED_RELAY_URL") {
        None => None,
        Some(value) => {
            absolute_url("ACE_HOSTED_RELAY_URL", value)?;
            Some(value.to_owned())
        }
    };
    if let Some(value) = env.get("ACE_PUSH_GATEWAY_URL") {
        push_gateway(value)?;
    }
    let web_origins = match env.get("ACE_WEB_ORIGINS") {
        None => Vec::new(),
        Some(value) => web_origins(value)?,
    };
    let version = env.get("ACE_VERSION").unwrap_or("development").to_owned();
    let _account_origin = account_url.unwrap_or_else(|| "https://cloud.acehq.dev".to_owned());
    let _hosted_relay_url = hosted_relay;
    Ok(Config {
        data_dir: resolve_data_dir(env, home)?,
        port: local_port,
        remote_port,
        listen,
        web_origins,
        log_level,
        safe_mode,
        ace_client: ace_client_name(&version),
        version,
        maintenance: env.get("ACE_MAINTENANCE") == Some("1"),
    })
}

/// `resolveDaemonHome`: `ACE_HOME` when set, otherwise `~/.ace`.
fn resolve_data_dir(env: &Env, home: &Path) -> Result<PathBuf, ConfigError> {
    let root = match env.get("ACE_HOME") {
        Some(requested) => resolve(Path::new(requested)),
        None => resolve(home).join(".ace"),
    };
    Ok(root)
}

/// `resolve()`: absolute paths stay as they are; relative ones join the
/// current directory, with no requirement that anything exists.
pub fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(current) => current.join(path),
        Err(_) => path.to_path_buf(),
    }
}
