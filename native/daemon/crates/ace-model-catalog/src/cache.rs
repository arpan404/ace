// SPDX-License-Identifier: Apache-2.0
//! Cache entries and their storage (`cache-schema.ts`, `storage.ts`).
//!
//! An entry is one instance's rows at one revision. Reads validate the whole entry:
//! version 2 only, 512 rows, same instance and provider, unique ids; non-account
//! sources are re-classified by `modelSource`, OpenCode's old bare `nativeModelId` is
//! repaired, and every row is frozen. Persistence is a port; [`MemoryStorage`] proves
//! the bounds (576 entries, 4 MiB per payload) and stands in for tests.

use std::collections::BTreeMap;
use std::sync::Arc;

use ace_models::freeze::freeze_catalog_model;
use ace_models::source::model_source_with;
use ace_protocol::generated::{CatalogModel, ModelSourceKind, ProviderKind};
use serde_json::Value;

/// The rows one instance cached, with the revisions that produced them.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub provider: ProviderKind,
    pub instance: String,
    pub login_revision: Option<String>,
    pub revision: String,
    pub refreshed_at: f64,
    pub models: Vec<Arc<CatalogModel>>,
    pub sources: Option<Vec<Value>>,
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
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheError {
    UnsupportedVersion,
    Malformed,
    RowMismatch,
    TooManyRows,
    TooManySources,
    TooManyModes,
    TooManyInstances,
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
            Self::PayloadTooLarge => "Model persistence byte backpressure",
        })
    }
}

impl std::error::Error for CacheError {}

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

/// Repairs a cached row to this build's shape, then freezes it.
fn repair(mut row: CatalogModel) -> Arc<CatalogModel> {
    if let Some(source) = row.source.take() {
        let source = (*source).clone();
        if source.kind != ModelSourceKind::Account {
            let id = row
                .native_provider_id
                .as_ref()
                .map(|provider| provider.0.0.clone())
                .unwrap_or_else(|| source.id.0.clone());
            row.source = Some(model_source_with(&id, &row.id.0, source).into());
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

/// Reads one persisted entry, or refuses the whole cache (`CachedEntry.parse`).
pub fn decode_entry(value: &Value) -> Result<CacheEntry, CacheError> {
    let entry = value.as_object().ok_or(CacheError::Malformed)?;
    match entry.get("schemaVersion") {
        None | Some(Value::Null) => {}
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
    for model in models {
        let row: CatalogModel =
            serde_json::from_value(model.clone()).map_err(|_| CacheError::Malformed)?;
        if row.instance.0 != instance || row.provider != provider {
            return Err(CacheError::RowMismatch);
        }
        if seen.contains(&row.id.0) {
            return Err(CacheError::RowMismatch);
        }
        seen.push(row.id.0.clone());
        rows.push(repair(row));
    }
    let sources = match entry.get("sources") {
        None | Some(Value::Null) => None,
        Some(Value::Array(sources)) => {
            if sources.len() > MAX_SOURCES {
                return Err(CacheError::TooManySources);
            }
            Some(sources.clone())
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
        identity_revision: optional_label(entry, "identityRevision")?,
        connection_revision: optional_label(entry, "connectionRevision")?,
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
        root.insert("sources".into(), Value::Array(sources.clone()));
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

/// The persistence port: one entry per instance, whole entries only.
pub trait CatalogStorage {
    fn load(&mut self) -> Vec<CacheEntry>;
    fn replace(&mut self, entry: &CacheEntry) -> Result<(), CacheError>;
    fn remove(&mut self, instance: &str) -> Result<(), CacheError>;
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
}

impl CatalogStorage for MemoryStorage {
    fn load(&mut self) -> Vec<CacheEntry> {
        std::mem::take(&mut self.entries).into_values().collect()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), CacheError> {
        let payload = encode_entry(entry)?;
        let bytes = serde_json::to_string(&payload)
            .map_err(|_| CacheError::Malformed)?
            .len();
        if bytes > MAX_PAYLOAD_BYTES {
            return Err(CacheError::PayloadTooLarge);
        }
        if !self.entries.contains_key(&entry.instance)
            && self.entries.len() >= MAX_PERSISTED_INSTANCES
        {
            return Err(CacheError::TooManyInstances);
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
    //! and `persistence-cap.process.test.ts`: only version 2 entries read, rows must
    //! belong to their instance with unique ids, old OpenCode rows are repaired,
    //! non-account sources are re-classified, and the storage caps hold.

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
    fn storage_keeps_one_entry_per_instance_within_its_caps() {
        let mut storage = MemoryStorage::new();
        let entry = decode_entry(&entry(vec![row("a")])).unwrap_or_else(|_| panic!("decodes"));
        storage.replace(&entry).unwrap_or_else(|_| panic!("stores"));
        let loaded = storage.load();
        assert_eq!(loaded.len(), 1);
        assert!(storage.load().is_empty());
        storage.replace(&entry).unwrap_or_else(|_| panic!("stores"));
        storage
            .remove("opencode")
            .unwrap_or_else(|_| panic!("removes"));
        assert!(storage.load().is_empty());
    }

    #[test]
    fn the_persisted_instance_cap_is_576() {
        let mut storage = MemoryStorage::new();
        let template = decode_entry(&entry(vec![row("a")])).unwrap_or_else(|_| panic!("decodes"));
        for index in 0..MAX_PERSISTED_INSTANCES {
            let mut next = template.clone();
            next.instance = format!("instance-{index}");
            next.models = Vec::new();
            storage
                .replace(&next)
                .unwrap_or_else(|_| panic!("stores {index}"));
        }
        let mut extra = template.clone();
        extra.instance = "over".into();
        extra.models = Vec::new();
        assert_eq!(
            storage.replace(&extra).err(),
            Some(CacheError::TooManyInstances)
        );
    }
}
