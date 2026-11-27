// SPDX-License-Identifier: Apache-2.0
//! The catalog's public value types: a row's freshness, its status, a page of rows and
//! the errors a request can fail with.

use ace_protocol::generated::{CatalogModel, ProviderKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cache::CacheError;
use crate::failures::DiscoveryError;
use crate::sources::SourceStatus;

/// The state a row's discovery is in, as clients read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    Fresh,
    Refreshing,
    Stale,
}

/// The short error a status carries (`ModelInstanceStatus.error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusError {
    DiscoveryFailed,
    Timeout,
    PersistenceFailed,
}

/// One row as clients read it (`ModelInstanceStatus`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceStatus {
    pub provider: ProviderKind,
    pub instance: String,
    #[serde(
        rename = "acpAgentId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub acp_agent_id: Option<String>,
    #[serde(
        rename = "installationId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub installation_id: Option<String>,
    #[serde(
        rename = "instanceId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub instance_id: Option<String>,
    #[serde(
        rename = "refreshedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub refreshed_at: Option<f64>,
    #[serde(
        rename = "lastRefreshedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_refreshed_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<RowStatus>,
    #[serde(
        rename = "errorDetail",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub error_detail: Option<DiscoveryError>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sources: Option<Vec<SourceStatus>>,
    pub stale: bool,
    pub refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<StatusError>,
    #[serde(
        rename = "permissionModes",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub permission_modes: Option<Vec<Value>>,
    #[serde(
        rename = "modelProbe",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub model_probe: Option<String>,
}

/// A page of rows and the statuses of the instances they came from (`ModelListResult`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListResult {
    pub models: Vec<CatalogModel>,
    pub instances: Vec<InstanceStatus>,
    #[serde(
        rename = "nextOffset",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub next_offset: Option<usize>,
}

/// A catalog request that cannot be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    Closed,
    StorageUnavailable,
    InvalidInstance,
    InstanceLimit,
    RemovalDraining,
    InstanceRemovalCapacity,
    ListenerLimit,
    Concurrency,
    Duration,
    TooManyCachedInstances,
    Cache(CacheError),
    SessionActivityCapacity,
    SessionGenerationChanged,
    InvalidationCapacity,
    DiscoverySourceLimit,
    DiscoveryCleanupLimit,
    InvalidListOptions,
    UnknownInstance,
    /// Retained work is at its bound; the caller may retry once it drains.
    Busy,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Closed => "Catalog closed",
            Self::StorageUnavailable => "Model catalog storage worker unavailable",
            Self::InvalidInstance => "Invalid model instance",
            Self::InstanceLimit => "Instance limit reached",
            Self::RemovalDraining => "Instance removal is still draining",
            Self::InstanceRemovalCapacity => "Instance removal capacity reached",
            Self::ListenerLimit => "Catalog listener limit reached",
            Self::Concurrency => "Invalid concurrency",
            Self::Duration => "Invalid catalog duration",
            Self::TooManyCachedInstances => "Too many cached instances",
            Self::Cache(error) => return error.fmt(f),
            Self::SessionActivityCapacity => "Session metadata capacity reached",
            Self::SessionGenerationChanged => "Session model generation changed",
            Self::InvalidationCapacity => "Invalidation capacity reached",
            Self::DiscoverySourceLimit => "Discovery source limit reached",
            Self::DiscoveryCleanupLimit => "Discovery cleanup limit reached",
            Self::InvalidListOptions => "Invalid model list options",
            Self::UnknownInstance => "Unknown instance",
            Self::Busy => "Catalog is busy",
        })
    }
}

impl std::error::Error for CatalogError {}

impl From<CacheError> for CatalogError {
    fn from(error: CacheError) -> Self {
        Self::Cache(error)
    }
}
