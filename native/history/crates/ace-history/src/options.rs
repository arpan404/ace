// SPDX-License-Identifier: Apache-2.0

//! The reader's options: `Options` in contracts.ts, already validated by the daemon.

use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
    Cursor,
    Pi,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Opencode => "opencode",
            Provider::Cursor => "cursor",
            Provider::Pi => "pi",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub id: String,
    pub provider: Provider,
    pub home_dir: PathBuf,
    #[serde(default)]
    pub offline_snapshot: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLimits {
    pub max_copy_bytes: Option<u64>,
    pub min_free_bytes: Option<u64>,
    pub min_free_ratio: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LastExit {
    Crash,
    MemoryLimit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub index_path: PathBuf,
    pub instances: Vec<Home>,
    #[serde(default)]
    pub snapshot: Option<SnapshotLimits>,
    #[serde(default)]
    pub last_exit: Option<LastExit>,
}

impl Options {
    /// The ids of the homes this reader scans.
    pub fn own_instances(&self) -> Vec<String> {
        self.instances.iter().map(|h| h.id.clone()).collect()
    }
}
