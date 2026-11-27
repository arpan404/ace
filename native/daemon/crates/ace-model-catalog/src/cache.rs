// SPDX-License-Identifier: Apache-2.0
//! Cache entries and their storage (`cache-schema.ts`, `storage.ts`, `storage-worker.ts`).
//!
//! An entry is one instance's rows at one revision. Reads validate the whole entry:
//! version 2 only, at most 576 entries, 512 rows, same instance and provider, unique ids,
//! and every row through `validate_row`; non-account sources are re-classified by
//! `modelSource` and their legacy statuses expanded into the model-specific routes,
//! OpenCode's old bare `nativeModelId` is repaired, every source error is rewritten to
//! ace's fixed text, and every row is frozen. Persistence is a port; [`MemoryStorage`]
//! proves the bounds (576 entries read, 64 CLI and 512 ACP written, 4 MiB per entry and
//! 256 KiB per ACP entry) and stands in for tests.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use ace_models::freeze::freeze_catalog_model;
use ace_models::row::validate_row;
use ace_models::source::model_source_with;
use ace_protocol::generated::{CatalogModel, ModelSource, ModelSourceKind, ProviderKind};
use serde_json::Value;

use crate::failures::{
    DISCOVERY_FAILURE_CODES, DiscoveryFailure, ErrorContext, FailureCode, discovery_error,
};
use crate::sources::SourceStatus;

/// The rows one instance cached, with the revisions that produced them.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub provider: ProviderKind,
    pub instance: String,
    pub login_revision: Option<String>,
    pub revision: String,
    pub refreshed_at: f64,
    pub models: Vec<Arc<CatalogModel>>,
    pub sources: Option<Vec<SourceStatus>>,
    pub permission_modes: Option<Vec<Value>>,
    pub identity_revision: Option<String>,
    pub connection_revision: Option<String>,
}

const MAX_ROWS: usize = 512;
const MAX_SOURCES: usize = 512;
const MAX_MODES: usize = 256;
const LABEL_LIMIT: usize = 256;
/// Persisted instances: 64 CLI accounts and 512 ACP agents (`storage-worker.ts`).
pub const MAX_PERSISTED_INSTANCES: usize = 576;
/// What one CLI account's row may weigh (`storage-worker.ts`).
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
/// What one ACP agent's row may weigh: a short list, held smaller.
pub const MAX_ACP_PAYLOAD_BYTES: usize = 256 * 1024;
/// The most CLI accounts (`catalog.ts` `kindLimit`).
pub const CLI_INSTANCE_LIMIT: usize = 64;
/// The most ACP agents (`catalog.ts` `kindLimit`).
pub const ACP_INSTANCE_LIMIT: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheError {
    UnsupportedVersion,
    Malformed,
    RowMismatch,
    TooManyRows,
    TooManySources,
    TooManyModes,
    TooManyInstances,
    EntryTooLarge,
    InstanceLimit,
    PayloadTooLarge,
}

impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnsupportedVersion => "The model cache holds entries in an older format",
            Self::Malformed => "The model cache entry is malformed",
            Self::RowMismatch => "Cached rows do not belong to their instance",
            Self::TooManyRows => "Too many cached models",
            Self::TooManySources => "Too many cached sources",
            Self::TooManyModes => "Too many cached permission modes",
            Self::TooManyInstances => "Too many persisted instances",
            Self::EntryTooLarge => "Cache entry exceeds limit",
            Self::InstanceLimit => "Persisted instance limit reached",
            Self::PayloadTooLarge => "Model persistence byte backpressure",
        })
    }
}

impl std::error::Error for CacheError {}

/// A label: 1 to 256 code points, Zod's `label`.
fn label(text: Option<&Value>) -> Option<String> {
    let text = text?.as_str()?;
    (1..=LABEL_LIMIT)
        .contains(&text.chars().count())
        .then(|| text.to_owned())
}

fn optional_label(
    entry: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, CacheError> {
    match entry.get(key) {
        None | Some(Value::Null) => Ok(None),
        value => label(value).map(Some).ok_or(CacheError::Malformed),
    }
}

fn required_label(entry: &serde_json::Map<String, Value>, key: &str) -> Result<String, CacheError> {
    label(entry.get(key)).ok_or(CacheError::Malformed)
}

/// `identityRevision`/`connectionRevision`: `z.string().max(256).optional()`, so `""` is
/// a value and `null` is not.
fn optional_short_text(
    entry: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, CacheError> {
    match entry.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= LABEL_LIMIT => Ok(Some(text.clone())),
        Some(_) => Err(CacheError::Malformed),
    }
}

/// Repairs a cached row to this build's shape and records its route.
fn repair(
    mut row: CatalogModel,
    routes: &mut HashMap<String, BTreeMap<String, ModelSource>>,
) -> Arc<CatalogModel> {
    if let Some(source) = row.source.take() {
        let source = (*source).clone();
        if source.kind != ModelSourceKind::Account {
            let old_id = source.id.0.clone();
            let id = row
                .native_provider_id
                .as_ref()
                .map(|provider| provider.0.0.clone())
                .unwrap_or_else(|| old_id.clone());
            let expanded = model_source_with(&id, &row.id.0, source);
            routes
                .entry(old_id)
                .or_default()
                .insert(expanded.id.0.clone(), expanded.clone());
            row.source = Some(expanded.into());
        } else {
            row.source = Some(source.into());
        }
    }
    // Before the execution-ID fix, OpenCode caches stored the bare model component.
    if row.provider == ProviderKind::Opencode
        && let Some(provider) = row
            .native_provider_id
            .as_ref()
            .map(|provider| provider.0.0.clone())
        && row.id.0 == format!("{provider}/{}", row.native_model_id.0)
    {
        row.native_model_id = row.id.0.clone().into();
    }
    freeze_catalog_model(row)
}

/// Rewrites a cached status error to ace's fixed message, as `cache-schema.ts` does.
fn rewrite_status(mut status: SourceStatus, provider: ProviderKind) -> SourceStatus {
    if let Some(error) = status.error.as_ref() {
        let raw = serde_json::to_value(error).unwrap_or(Value::Null);
        let code = raw
            .get("code")
            .and_then(Value::as_str)
            .and_then(|code| {
                DISCOVERY_FAILURE_CODES
                    .iter()
                    .copied()
                    .find(|known| known.as_str() == code)
            })
            .unwrap_or(FailureCode::DiscoveryFailed);
        status.error = Some(discovery_error(
            Some(&DiscoveryFailure {
                code: Some(code.as_str().to_owned()),
                ..DiscoveryFailure::default()
            }),
            code,
            &ErrorContext {
                provider: Some(&provider.to_string()),
                source: Some(&status.source.id.0),
                backend: None,
            },
        ));
    }
    status
}

/// Expands a cached entry's legacy statuses into the model-specific routes.
fn expand_sources(
    sources: Vec<SourceStatus>,
    routes: &HashMap<String, BTreeMap<String, ModelSource>>,
    provider: ProviderKind,
) -> Vec<SourceStatus> {
    let mut expanded = Vec::new();
    for status in sources {
        let old_id = status.source.id.0.clone();
        let sources: Vec<ModelSource> = match routes.get(&old_id) {
            Some(known) => known.values().cloned().collect(),
            None => vec![model_source_with(&old_id, "", status.source.clone())],
        };
        for source in sources {
            let mut next = status.clone();
            next.source = source;
            expanded.push(rewrite_status(next, provider));
        }
    }
    expanded
}

/// Reads one persisted entry, or refuses the whole cache (`CachedEntry.parse`).
pub fn decode_entry(value: &Value) -> Result<CacheEntry, CacheError> {
    let entry = value.as_object().ok_or(CacheError::Malformed)?;
    match entry.get("schemaVersion") {
        // `.default(2)`: an absent version is this build's; a present one must be 2.
        None => {}
        Some(Value::Number(version)) if version.as_u64() == Some(2) => {}
        Some(_) => return Err(CacheError::UnsupportedVersion),
    }
    let provider = entry
        .get("provider")
        .and_then(Value::as_str)
        .ok_or(CacheError::Malformed)?;
    let provider: ProviderKind = provider.parse().map_err(|_| CacheError::Malformed)?;
    let instance = required_label(entry, "instance")?;
    let revision = required_label(entry, "revision")?;
    let refreshed_at = entry
        .get("refreshedAt")
        .and_then(Value::as_f64)
        .filter(|value| *value >= 0.0)
        .ok_or(CacheError::Malformed)?;
    let models = entry
        .get("models")
        .and_then(Value::as_array)
        .ok_or(CacheError::Malformed)?;
    if models.len() > MAX_ROWS {
        return Err(CacheError::TooManyRows);
    }
    let mut seen = Vec::new();
    let mut rows = Vec::with_capacity(models.len());
    let mut routes: HashMap<String, BTreeMap<String, ModelSource>> = HashMap::new();
    for model in models {
        let row: CatalogModel =
            serde_json::from_value(model.clone()).map_err(|_| CacheError::Malformed)?;
        validate_row(&row).map_err(|_| CacheError::Malformed)?;
        if row.instance.0 != instance || row.provider != provider {
            return Err(CacheError::RowMismatch);
        }
        if seen.contains(&row.id.0) {
            return Err(CacheError::RowMismatch);
        }
        seen.push(row.id.0.clone());
        rows.push(repair(row, &mut routes));
    }
    let sources = match entry.get("sources") {
        None | Some(Value::Null) => None,
        Some(Value::Array(sources)) => {
            if sources.len() > MAX_SOURCES {
                return Err(CacheError::TooManySources);
            }
            let statuses = sources
                .iter()
                .map(|source| {
                    serde_json::from_value::<SourceStatus>(source.clone())
                        .map_err(|_| CacheError::Malformed)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Some(expand_sources(statuses, &routes, provider))
        }
        Some(_) => return Err(CacheError::Malformed),
    };
    let permission_modes = match entry.get("permissionModes") {
        None | Some(Value::Null) => None,
        Some(Value::Array(modes)) => {
            if modes.len() > MAX_MODES {
                return Err(CacheError::TooManyModes);
            }
            Some(modes.clone())
        }
        Some(_) => return Err(CacheError::Malformed),
    };
    Ok(CacheEntry {
        provider,
        instance,
        login_revision: optional_label(entry, "loginRevision")?,
        revision,
        refreshed_at,
        models: rows,
        sources,
        permission_modes,
        identity_revision: optional_short_text(entry, "identityRevision")?,
        connection_revision: optional_short_text(entry, "connectionRevision")?,
    })
}

/// A persisted entry's JSON payload: the cache's stored shape.
pub fn encode_entry(entry: &CacheEntry) -> Result<Value, CacheError> {
    let mut root = serde_json::Map::new();
    root.insert("schemaVersion".into(), Value::Number(2.into()));
    root.insert("provider".into(), Value::String(entry.provider.to_string()));
    root.insert("instance".into(), Value::String(entry.instance.clone()));
    root.insert("revision".into(), Value::String(entry.revision.clone()));
    root.insert("refreshedAt".into(), Value::from(entry.refreshed_at));
    let models = entry
        .models
        .iter()
        .map(|model| serde_json::to_value(&**model).map_err(|_| CacheError::Malformed))
        .collect::<Result<Vec<_>, _>>()?;
    root.insert("models".into(), Value::Array(models));
    if let Some(login) = &entry.login_revision {
        root.insert("loginRevision".into(), Value::String(login.clone()));
    }
    if let Some(sources) = &entry.sources {
        let sources = sources
            .iter()
            .map(|source| serde_json::to_value(source).map_err(|_| CacheError::Malformed))
            .collect::<Result<Vec<_>, _>>()?;
        root.insert("sources".into(), Value::Array(sources));
    }
    if let Some(modes) = &entry.permission_modes {
        root.insert("permissionModes".into(), Value::Array(modes.clone()));
    }
    if let Some(identity) = &entry.identity_revision {
        root.insert("identityRevision".into(), Value::String(identity.clone()));
    }
    if let Some(connection) = &entry.connection_revision {
        root.insert(
            "connectionRevision".into(),
            Value::String(connection.clone()),
        );
    }
    Ok(Value::Object(root))
}

/// The documented payload budget one provider's entry may not exceed.
pub fn payload_limit(provider: ProviderKind) -> usize {
    if provider == ProviderKind::Acp {
        MAX_ACP_PAYLOAD_BYTES
    } else {
        MAX_PAYLOAD_BYTES
    }
}

/// Whether an entry is already over its provider's budget before it is queued.
pub fn entry_over_budget(entry: &CacheEntry) -> bool {
    let Ok(payload) = encode_entry(entry) else {
        return true;
    };
    let Ok(text) = serde_json::to_string(&payload) else {
        return true;
    };
    text.len() > payload_limit(entry.provider)
}

/// The row checks a cached entry must pass before it is stored (`CachedEntry.refine`).
pub fn validate_entry(entry: &CacheEntry) -> Result<(), CacheError> {
    if entry.models.len() > MAX_ROWS {
        return Err(CacheError::TooManyRows);
    }
    if entry.permission_modes.as_ref().is_some_and(|modes| {
        modes.len() > MAX_MODES
            || modes.iter().any(|mode| {
                let Some(mode) = mode.as_object() else {
                    return true;
                };
                let label = |key: &str, max: usize| {
                    mode.get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|text| (1..=max).contains(&text.chars().count()))
                };
                let known = [
                    "id",
                    "label",
                    "description",
                    "risk",
                    "presentation",
                    "default",
                ];
                !mode.keys().all(|key| known.contains(&key.as_str()))
                    || mode.get("default").is_some_and(|value| !value.is_boolean())
                    || mode
                        .get("presentation")
                        .is_some_and(|value| value.as_str() != Some("full-access"))
                    || !label("id", 4096)
                    || !label("label", 256)
                    || mode
                        .get("description")
                        .and_then(Value::as_str)
                        .is_none_or(|text| text.chars().count() > 2048)
                    || !mode
                        .get("risk")
                        .and_then(Value::as_str)
                        .is_some_and(|risk| matches!(risk, "low" | "medium" | "high"))
            })
    }) {
        return Err(CacheError::TooManyModes);
    }
    let mut seen = Vec::with_capacity(entry.models.len());
    for row in &entry.models {
        if row.instance.0 != entry.instance || row.provider != entry.provider {
            return Err(CacheError::RowMismatch);
        }
        if seen.contains(&row.id.0) {
            return Err(CacheError::RowMismatch);
        }
        seen.push(row.id.0.clone());
    }
    Ok(())
}

/// Reads a whole cache, refusing more than 576 persisted instances (`storage.ts`).
pub fn decode_entries(
    payloads: impl IntoIterator<Item = Value>,
) -> Result<Vec<CacheEntry>, CacheError> {
    let payloads: Vec<Value> = payloads.into_iter().collect();
    if payloads.len() > MAX_PERSISTED_INSTANCES {
        return Err(CacheError::TooManyInstances);
    }
    payloads.iter().map(decode_entry).collect()
}

/// The persistence port: one entry per instance, whole entries only.
pub trait CatalogStorage {
    fn load(&mut self) -> Result<Vec<CacheEntry>, CacheError>;
    fn replace(&mut self, entry: &CacheEntry) -> Result<(), CacheError>;
    fn remove(&mut self, instance: &str) -> Result<(), CacheError>;
    /// Releases the storage's own resources. The default keeps in-memory stores open.
    fn close(&mut self) -> Result<(), CacheError> {
        Ok(())
    }
}

/// The bounds every storage implementation keeps, and an in-memory one for tests.
#[derive(Debug, Default)]
pub struct MemoryStorage {
    entries: BTreeMap<String, CacheEntry>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }

    fn kind(provider: ProviderKind) -> bool {
        provider == ProviderKind::Acp
    }
}

impl CatalogStorage for MemoryStorage {
    fn load(&mut self) -> Result<Vec<CacheEntry>, CacheError> {
        if self.entries.len() > MAX_PERSISTED_INSTANCES {
            return Err(CacheError::TooManyInstances);
        }
        Ok(std::mem::take(&mut self.entries).into_values().collect())
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), CacheError> {
        validate_entry(entry)?;
        let payload = encode_entry(entry)?;
        let bytes = serde_json::to_string(&payload)
            .map_err(|_| CacheError::Malformed)?
            .len();
        let acp = Self::kind(entry.provider);
        if bytes
            > if acp {
                MAX_ACP_PAYLOAD_BYTES
            } else {
                MAX_PAYLOAD_BYTES
            }
        {
            return Err(CacheError::EntryTooLarge);
        }
        if !self.entries.contains_key(&entry.instance) {
            let same_kind = self
                .entries
                .values()
                .filter(|existing| Self::kind(existing.provider) == acp)
                .count();
            let limit = if acp {
                ACP_INSTANCE_LIMIT
            } else {
                CLI_INSTANCE_LIMIT
            };
            if same_kind >= limit {
                return Err(CacheError::InstanceLimit);
            }
        }
        self.entries.insert(entry.instance.clone(), entry.clone());
        Ok(())
    }

    fn remove(&mut self, instance: &str) -> Result<(), CacheError> {
        self.entries.remove(instance);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Ports the cache cases of `packages/models/src/cache-format.process.test.ts`
    //! ("a valid cache keeps its frozen rows...", "an entry with a row of another
    //! instance is refused"), `persistence-cap.process.test.ts` ("64 CLI accounts and
    //! 512 ACP agents, 256 KiB per ACP payload"), and `cache-schema.ts`'s legacy source
    //! expansion.

    use super::*;
    use ace_models::instance::ModelInstance;
    use serde_json::json;

    fn row(id: &str) -> CatalogModel {
        ace_models::row::base(
            &ModelInstance::cli("opencode", ProviderKind::Opencode, "", "/repo"),
            id,
            id,
            &json!({}),
        )
    }

    fn entry(models: Vec<CatalogModel>) -> Value {
        let models: Vec<Value> = models
            .iter()
            .map(|model| serde_json::to_value(model).unwrap_or(Value::Null))
            .collect();
        json!({
            "schemaVersion": 2,
            "provider": "opencode",
            "instance": "opencode",
            "revision": "r1",
            "refreshedAt": 10,
            "models": models
        })
    }

    #[test]
    fn only_version_two_entries_and_rows_of_their_instance_read() {
        let ok = decode_entry(&entry(vec![row("a")]));
        assert_eq!(ok.map(|entry| entry.models.len()), Ok(1));
        let mut old = entry(vec![row("a")]);
        old["schemaVersion"] = json!(1);
        assert_eq!(
            decode_entry(&old).err(),
            Some(CacheError::UnsupportedVersion)
        );
        // `z.literal(2)` rejects null; only an absent version takes the default.
        let mut null = entry(vec![row("a")]);
        null["schemaVersion"] = Value::Null;
        assert_eq!(
            decode_entry(&null).err(),
            Some(CacheError::UnsupportedVersion)
        );
        let mut absent = entry(vec![row("a")]);
        absent
            .as_object_mut()
            .map(|entry| entry.remove("schemaVersion"));
        assert!(decode_entry(&absent).is_ok());
        let mut foreign = entry(vec![row("a")]);
        foreign["instance"] = json!("another");
        assert_eq!(decode_entry(&foreign).err(), Some(CacheError::RowMismatch));
        let mut duplicate = entry(vec![row("a")]);
        let first = duplicate["models"][0].clone();
        duplicate["models"] = json!([first.clone(), first]);
        assert_eq!(
            decode_entry(&duplicate).err(),
            Some(CacheError::RowMismatch)
        );
    }

    #[test]
    fn a_row_the_protocol_refuses_refuses_the_whole_cache() {
        let mut efforts = row("a");
        efforts.efforts = ace_protocol::generated::Schema324(
            (0..33)
                .map(|index| ace_protocol::generated::ModelEffort {
                    id: format!("e{index}").into(),
                    level: None,
                    label: format!("E{index}").into(),
                })
                .collect(),
        );
        assert_eq!(
            decode_entry(&entry(vec![efforts])).err(),
            Some(CacheError::Malformed)
        );
        let mut unnamed = row("a");
        unnamed.display_name = "".to_owned().into();
        assert_eq!(
            decode_entry(&entry(vec![unnamed])).err(),
            Some(CacheError::Malformed)
        );
        let mut oversized_raw = row("a");
        oversized_raw.raw = ace_protocol::generated::CatalogRaw {
            json: "x".repeat(10_000),
            truncated: false,
        };
        assert_eq!(
            decode_entry(&entry(vec![oversized_raw])).err(),
            Some(CacheError::Malformed)
        );
    }

    #[test]
    fn revisions_allow_the_empty_identity_the_typescript_allows() {
        let mut value = entry(vec![row("a")]);
        value["identityRevision"] = json!("");
        value["connectionRevision"] = json!("c1");
        let decoded = decode_entry(&value).unwrap_or_else(|_| panic!("decodes"));
        assert_eq!(decoded.identity_revision.as_deref(), Some(""));
        assert_eq!(decoded.connection_revision.as_deref(), Some("c1"));
        value["identityRevision"] = Value::Null;
        assert_eq!(decode_entry(&value).err(), Some(CacheError::Malformed));
    }

    #[test]
    fn an_old_opencode_row_is_repaired_to_the_qualified_selector() {
        let mut model = row("opencode/deepseek-v4.1-flash");
        model.native_provider_id = ace_models::row::decoded_text(Some("opencode"));
        model.native_model_id = "deepseek-v4.1-flash".to_owned().into();
        let entry = decode_entry(&entry(vec![model])).unwrap_or_else(|_| panic!("decodes"));
        assert_eq!(entry.models[0].id.0, "opencode/deepseek-v4.1-flash");
        assert_eq!(
            entry.models[0].native_model_id.0,
            "opencode/deepseek-v4.1-flash"
        );
    }

    #[test]
    fn a_legacy_route_status_expands_into_its_model_specific_sources() {
        // Ollama's cloud models are their own route, so a legacy "ollama" status
        // expands into the routes its rows reported (model-source.ts).
        let mut model = row("ollama/qwen3:cloud");
        model.native_provider_id = ace_models::row::decoded_text(Some("ollama"));
        // The legacy stored shape: the cloud row still carried the provider's source.
        model.source = Some(ace_models::source::provider_source("ollama").into());
        let mut value = entry(vec![model]);
        value["sources"] = json!([{
            "source": { "id": "ollama", "kind": "local", "label": "Ollama" },
            "status": "fresh",
            "error": {
                "code": "auth_expired",
                "message": "private provider prose",
                "hint": "private hint"
            }
        }]);
        let decoded = decode_entry(&value).unwrap_or_else(|_| panic!("decodes"));
        let sources = decoded.sources.unwrap_or_default();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source.id.0, "ollama-cloud");
        let error = sources[0].error.as_ref().unwrap_or_else(|| panic!("error"));
        assert_eq!(error.code, FailureCode::AuthExpired);
        assert_eq!(error.message, "Provider sign-in has expired.");
        assert!(!error.hint.contains("private"));
    }

    #[test]
    fn storage_keeps_one_entry_per_instance_within_its_caps() {
        let mut storage = MemoryStorage::new();
        let first = decode_entry(&entry(vec![row("a")])).unwrap_or_else(|_| panic!("decodes"));
        storage.replace(&first).unwrap_or_else(|_| panic!("stores"));
        let loaded = storage.load().unwrap_or_else(|_| panic!("loads"));
        assert_eq!(loaded.len(), 1);
        assert!(
            storage
                .load()
                .unwrap_or_else(|_| panic!("loads"))
                .is_empty()
        );
        storage.replace(&first).unwrap_or_else(|_| panic!("stores"));
        storage
            .remove("opencode")
            .unwrap_or_else(|_| panic!("removes"));
        assert!(
            storage
                .load()
                .unwrap_or_else(|_| panic!("loads"))
                .is_empty()
        );
    }

    fn stored(provider: ProviderKind, instance: &str) -> CacheEntry {
        let mut entry = decode_entry(&entry(vec![row("a")])).unwrap_or_else(|_| panic!("decodes"));
        entry.provider = provider;
        entry.instance = instance.to_owned();
        entry.models.clear();
        entry
    }

    #[test]
    fn the_write_caps_are_64_cli_accounts_and_512_acp_agents() {
        let mut storage = MemoryStorage::new();
        for index in 0..CLI_INSTANCE_LIMIT {
            storage
                .replace(&stored(ProviderKind::Codex, &format!("cli-{index}")))
                .unwrap_or_else(|_| panic!("stores cli {index}"));
        }
        assert_eq!(
            storage.replace(&stored(ProviderKind::Codex, "over")),
            Err(CacheError::InstanceLimit)
        );
        // ACP rows have their own capacity, so a full CLI kind does not block them.
        for index in 0..ACP_INSTANCE_LIMIT {
            storage
                .replace(&stored(ProviderKind::Acp, &format!("acp-{index}")))
                .unwrap_or_else(|_| panic!("stores acp {index}"));
        }
        assert_eq!(
            storage.replace(&stored(ProviderKind::Acp, "over")),
            Err(CacheError::InstanceLimit)
        );
        // Replacing an existing row is always admitted.
        storage
            .replace(&stored(ProviderKind::Acp, "acp-0"))
            .unwrap_or_else(|_| panic!("replaces"));
    }

    #[test]
    fn an_acp_entry_is_held_to_256_kib_while_a_cli_entry_may_reach_4_mib() {
        let mut storage = MemoryStorage::new();
        let mut acp = stored(ProviderKind::Acp, "agent");
        let agent = ModelInstance::cli("agent", ProviderKind::Acp, "", "/repo");
        let mut padded = ace_models::row::base(&agent, "model", "model", &json!({}));
        padded.raw = ace_protocol::generated::CatalogRaw {
            json: "x".repeat(2048),
            truncated: false,
        };
        acp.models = (0..200)
            .map(|index| {
                let mut next = padded.clone();
                next.id = format!("model-{index}").into();
                std::sync::Arc::new(next)
            })
            .collect();
        assert_eq!(storage.replace(&acp), Err(CacheError::EntryTooLarge));
        let mut cli = acp.clone();
        cli.provider = ProviderKind::Codex;
        cli.instance = "account".into();
        let account = ModelInstance::cli("account", ProviderKind::Codex, "", "/repo");
        cli.models = acp
            .models
            .iter()
            .enumerate()
            .map(|(index, _)| {
                let mut next =
                    ace_models::row::base(&account, &format!("model-{index}"), "model", &json!({}));
                next.raw = ace_protocol::generated::CatalogRaw {
                    json: "x".repeat(2048),
                    truncated: false,
                };
                std::sync::Arc::new(next)
            })
            .collect();
        storage
            .replace(&cli)
            .unwrap_or_else(|_| panic!("a CLI row may weigh up to 4 MiB"));
    }

    #[test]
    fn a_row_past_512_and_a_malformed_permission_mode_are_refused_on_write() {
        let mut storage = MemoryStorage::new();
        let mut entry = stored(ProviderKind::Codex, "account");
        let agent = ModelInstance::cli("account", ProviderKind::Codex, "", "/repo");
        entry.models = (0..513)
            .map(|index| Arc::new(row(&format!("model-{index}"))))
            .collect();
        let _ = agent;
        assert_eq!(storage.replace(&entry), Err(CacheError::TooManyRows));
        entry.models.clear();
        entry.permission_modes = Some(vec![json!({ "id": "plan", "risk": "medium" })]);
        assert_eq!(storage.replace(&entry), Err(CacheError::TooManyModes));
    }

    #[test]
    fn every_permission_mode_is_parsed_like_the_protocol_does() {
        let mut storage = MemoryStorage::new();
        let mut entry = stored(ProviderKind::Codex, "account");
        for modes in [
            json!([null]),
            json!([{ "id": "plan", "label": "Plan", "description": "", "risk": "low", "default": "yes" }]),
            json!([{ "id": "plan", "label": "Plan", "description": "", "risk": "low", "stray": 1 }]),
        ] {
            entry.permission_modes = Some(modes.as_array().cloned().unwrap_or_default());
            assert_eq!(storage.replace(&entry), Err(CacheError::TooManyModes));
        }
        entry.permission_modes = Some(vec![json!({
            "id": "plan", "label": "Plan", "description": "", "risk": "low", "default": false
        })]);
        assert!(storage.replace(&entry).is_ok());
    }

    #[test]
    fn a_cache_of_more_than_576_payloads_is_refused_before_any_row_is_read() {
        let payload = entry(vec![]);
        let payloads: Vec<Value> = (0..=MAX_PERSISTED_INSTANCES)
            .map(|_| payload.clone())
            .collect();
        assert_eq!(
            decode_entries(payloads).err(),
            Some(CacheError::TooManyInstances)
        );
        let ok: Vec<Value> = (0..MAX_PERSISTED_INSTANCES)
            .map(|_| payload.clone())
            .collect();
        assert_eq!(
            decode_entries(ok).map(|entries| entries.len()),
            Ok(MAX_PERSISTED_INSTANCES)
        );
    }
}

/// A storage port shared by the catalog's flights and its spawned writes.
#[derive(Clone)]
pub struct SharedStorage(std::sync::Arc<std::sync::Mutex<Box<dyn CatalogStorage + Send>>>);

impl SharedStorage {
    pub fn new(storage: impl CatalogStorage + Send + 'static) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(Box::new(
            storage,
        ))))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Box<dyn CatalogStorage + Send>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn load(&mut self) -> Result<Vec<CacheEntry>, CacheError> {
        let mut guard = self.lock();
        guard.as_mut().load()
    }

    pub fn replace(&mut self, entry: &CacheEntry) -> Result<(), CacheError> {
        let mut guard = self.lock();
        guard.as_mut().replace(entry)
    }

    pub fn remove(&mut self, instance: &str) -> Result<(), CacheError> {
        let mut guard = self.lock();
        guard.as_mut().remove(instance)
    }

    pub fn close(&mut self) -> Result<(), CacheError> {
        let mut guard = self.lock();
        guard.as_mut().close()
    }
}

impl std::fmt::Debug for SharedStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SharedStorage")
    }
}
