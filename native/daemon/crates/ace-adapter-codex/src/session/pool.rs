// SPDX-License-Identifier: Apache-2.0
//! Live app-servers by everything fixed at spawn (`CodexHostPool`,
//! `host-pool.ts:34`–`:168`): executable, environment (the account home) and
//! process-level arguments. Thread-level settings travel in each
//! `thread/start`, so sessions on one account share one process. A shared
//! host with no sessions stays up for the next one, for ten minutes.

use std::sync::Arc;

use ace_adapter_api::util::ElisionLimits;
use ace_json::Value;
use indexmap::IndexMap;

use super::host::{Host, HostConfig};

/// A shared app-server with no sessions stays up this long for the next one
/// (`defaultHostIdleMs`, `:11`).
pub const DEFAULT_HOST_IDLE_MS: f64 = 600_000.0;

/// Codex keeps every generated image inline as base64 (`imageGeneration.result`,
/// megabytes each) and returns them with history on `thread/resume` and
/// `thread/read`. ace reads only the item's `savedPath`, so base64 past 16 KiB
/// becomes a placeholder before the line limit counts it (`codexElision`, `:23`).
///
/// Readable text is never cut short of the 16 MiB line limit: command output,
/// diffs and messages are payload ace shows, and a frame past the provider
/// payload bound already has an explicit outcome.
pub const CODEX_ELISION: ElisionLimits = ElisionLimits {
    hold_bytes: 16 * 1024,
    text_bytes: 16 * 1024 * 1024,
};

/// What every ace app-server is told about its client (`initialize`, `:25`).
pub fn initialize() -> Value {
    ace_json::json!({
        "clientInfo": {"name": "ace", "title": "ace", "version": "0.0.0"},
        "capabilities": {"experimentalApi": true, "requestAttestation": false},
    })
}

/// A pool refusal (`host-pool.ts:40`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PoolError {
    #[error("Invalid Codex host idle time")]
    InvalidIdle,
}

/// What `openChannel` should do for one spawn key (`host`, `:47`–`:67`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// A live host to reuse.
    Reuse,
    /// No host fits: start one and call `started`.
    Start,
    /// Another caller is starting this key right now.
    Waiting,
}

/// Live app-servers by spawn key, and the keys being started.
pub struct HostPool {
    idle_ms: f64,
    hosts: IndexMap<String, Arc<Host>>,
    starting: Vec<String>,
}

impl HostPool {
    /// A pool with `idle_ms` (ten minutes when absent), refusing the idle times
    /// the TypeScript throws for.
    pub fn new(idle_ms: Option<f64>) -> Result<HostPool, PoolError> {
        let idle_ms = idle_ms.unwrap_or(DEFAULT_HOST_IDLE_MS);
        if !idle_ms.is_finite() || idle_ms.fract() != 0.0 || idle_ms < 0.0 {
            return Err(PoolError::InvalidIdle);
        }
        Ok(HostPool {
            idle_ms,
            hosts: IndexMap::new(),
            starting: Vec::new(),
        })
    }

    pub fn idle_ms(&self) -> f64 {
        self.idle_ms
    }

    /// What one channel's open should do with `key`: reuse a live host, start
    /// one, or wait for the start already running.
    pub fn open_channel(&self, key: &str) -> Channel {
        if let Some(host) = self.hosts.get(key)
            && host.available()
        {
            return Channel::Reuse;
        }
        if self.starting.iter().any(|starting| starting == key) {
            return Channel::Waiting;
        }
        Channel::Start
    }

    /// A new host is being started for `key`; later opens wait for it.
    pub fn claim(&mut self, key: &str) -> bool {
        if self.starting.iter().any(|starting| starting == key) {
            return false;
        }
        self.starting.push(key.to_owned());
        true
    }

    /// The start finished: keep the host if it is still available.
    pub fn started(&mut self, key: &str, host: Arc<Host>) {
        self.starting.retain(|starting| starting != key);
        if host.available() {
            self.hosts.insert(key.to_owned(), host);
        }
    }

    /// The start failed; the key is free for the next open.
    pub fn start_failed(&mut self, key: &str) {
        self.starting.retain(|starting| starting != key);
    }

    /// A host retired (`onRetired`): the key no longer names it.
    pub fn released(&mut self, key: &str) {
        self.hosts.shift_remove(key);
    }

    pub fn host(&self, key: &str) -> Option<&Arc<Host>> {
        self.hosts.get(key)
    }

    pub fn keys(&self) -> Vec<String> {
        self.hosts.keys().cloned().collect()
    }

    /// Stop every app-server, whatever sessions remain on it (`close`, `:44`).
    /// The caller retires each host and drops the pool.
    pub fn close(&mut self) -> Vec<(String, Arc<Host>)> {
        self.starting.clear();
        self.hosts.drain(..).collect()
    }
}

/// Everything fixed at spawn that makes two sessions share one process
/// (`spawnKey`, `:82`): executable, built-in-skill arguments, tool-source
/// arguments and the environment, without the per-session MCP bearer.
pub struct SpawnIdentity<'a> {
    pub executable: Option<&'a str>,
    pub builtin_skills_args: &'a [String],
    pub tool_config_args: &'a [String],
    pub env: &'a [(String, String)],
}

/// The key a session asks the pool for. A changed tool source or environment
/// starts a fresh app-server instead of joining one without it.
pub fn spawn_key(identity: &SpawnIdentity<'_>) -> String {
    let mut entries: Vec<(&str, &str)> = identity
        .env
        .iter()
        .filter(|(name, _)| name != "ACE_MCP_BEARER_TOKEN")
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    entries.sort_by_key(|(name, _)| *name);
    let env: Vec<Value> = entries
        .iter()
        .map(|(name, value)| {
            Value::Array(ace_json::Array::from(vec![
                Value::from(*name),
                Value::from(*value),
            ]))
        })
        .collect();
    ace_json::json!([
        identity.executable,
        identity.builtin_skills_args,
        identity.tool_config_args,
        env,
    ])
    .to_json()
}

/// A shared host's config, its idle time fixed by the pool.
pub fn shared_config(idle_ms: f64) -> HostConfig {
    HostConfig::shared(initialize(), idle_ms)
}

#[cfg(test)]
mod tests;
