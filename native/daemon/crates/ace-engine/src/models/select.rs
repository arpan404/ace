// SPDX-License-Identifier: Apache-2.0
//! `EngineModels`' synchronous reads (E5.4e): the catalog-backed `select`, the permission
//! capability merges and the modes write. `prepare` (async) and `migrateCachedDefaults` stay
//! E5.6's.

use ace_json::{Map, Value};

use crate::EngineError;
use crate::models::selection::{execution_model_id, is_default_selection, selection_model_filter};
use crate::ports::Ports;

/// The slice of `ModelCatalogApi` the synchronous receipt calls (`models.ts:37`-`:105`).
pub trait Catalog {
    fn resolve(&self, spec: &Value) -> Result<Value, EngineError>;
    fn list(&self, options: &Value) -> Result<Value, EngineError>;
    fn update_permission_modes(&self, instance: &str, modes: &Value) -> Result<(), EngineError>;
    /// `options.onModelUnavailable` (`models.ts:82`), called before the throw.
    fn rejected(&self, provider: &str, model: &str, instance: Option<&str>);
}

/// The catalog over the shell's `models` port: JSON in, JSON out.
pub struct PortCatalog<'a>(pub &'a dyn Ports);

impl Catalog for PortCatalog<'_> {
    fn resolve(&self, spec: &Value) -> Result<Value, EngineError> {
        let text = self.0.models_resolve(&ace_json::to_string(spec))?;
        ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))
    }

    fn list(&self, options: &Value) -> Result<Value, EngineError> {
        let text = self.0.models_list(&ace_json::to_string(options))?;
        ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))
    }

    fn update_permission_modes(&self, instance: &str, modes: &Value) -> Result<(), EngineError> {
        self.0
            .models_update_permission_modes(instance, &ace_json::to_string(modes))?;
        Ok(())
    }

    fn rejected(&self, provider: &str, model: &str, instance: Option<&str>) {
        self.0.on_model_unavailable(provider, model, instance);
    }
}

/// `EngineModels.permissionCapabilities` (`models.ts:48`): the catalog's modes, else the base.
pub fn permission_capabilities(
    catalog: Option<&dyn Catalog>,
    provider: &str,
    instance: Option<&str>,
    base: &Value,
) -> Result<Value, EngineError> {
    Ok(
        known_permission_capabilities(catalog, provider, instance, base)?
            .unwrap_or_else(|| base.clone()),
    )
}

/// `knownPermissionCapabilities` (`models.ts:56`): an agent that reported no modes is unknown,
/// not one that offers nothing.
pub fn known_permission_capabilities(
    catalog: Option<&dyn Catalog>,
    provider: &str,
    instance: Option<&str>,
    base: &Value,
) -> Result<Option<Value>, EngineError> {
    let Some(catalog) = catalog else {
        return Ok(None);
    };
    let mut options = Map::new();
    options.insert("provider", Value::from(provider));
    let list = catalog.list(&Value::Object(options))?;
    let target = instance.map_or_else(|| format!("{provider}-cli-default"), str::to_owned);
    let status = list
        .get("instances")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("instance").and_then(Value::as_str) == Some(target.as_str())
                    || row.get("instanceId").and_then(Value::as_str) == Some(target.as_str())
            })
        });
    let Some(status) = status else {
        return Ok(None);
    };
    let modes = status.get("permissionModes").and_then(Value::as_array);
    let Some(modes) = modes.filter(|modes| !modes.is_empty()) else {
        return Ok(None);
    };
    if base.get("permissions").is_none_or(Value::is_null) {
        return Ok(None);
    }
    let mut merged = base.as_object().cloned().unwrap_or_default();
    merged.insert("permissionModes", Value::Array(modes.clone()));
    if let Some(access_modes) = status.get("accessModes") {
        merged.insert("accessModes", access_modes.clone());
    }
    let mut permissions = base
        .get("permissions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    permissions.insert("permissionModes", Value::Array(modes.clone()));
    permissions.insert(
        "modes",
        Value::Array(
            modes
                .iter()
                .filter_map(|mode| mode.get("id").cloned())
                .collect(),
        ),
    );
    merged.insert("permissions", Value::Object(permissions));
    Ok(Some(Value::Object(merged)))
}

/// `EngineModels.permissions` (`models.ts:75`): record the modes the instance reported.
pub fn permissions(
    catalog: Option<&dyn Catalog>,
    instance: Option<&str>,
    capabilities: &Value,
) -> Result<(), EngineError> {
    let (Some(catalog), Some(instance), Some(modes)) =
        (catalog, instance, capabilities.get("permissionModes"))
    else {
        return Ok(());
    };
    catalog.update_permission_modes(instance, modes)
}

/// `EngineModels.select` (`models.ts:82`-`:106`): the execution model id, the default sentinel's
/// `undefined`, or `model_unavailable` for an explicit model the catalog cannot resolve.
pub fn select(
    catalog: Option<&dyn Catalog>,
    provider: &str,
    model: Option<&str>,
    instance: Option<&str>,
    identity: Option<&Value>,
) -> Result<Option<String>, EngineError> {
    let Some(catalog) = catalog else {
        return Ok(if is_default_selection(model) {
            None
        } else {
            model.map(str::to_owned)
        });
    };
    let Some(filter) = selection_model_filter(provider, instance, identity) else {
        return reject(catalog, provider, model, instance);
    };
    let mut spec = filter.as_object().cloned().unwrap_or_default();
    spec.insert("role", Value::from("thread"));
    if let Some(model) = model
        && !is_default_selection(Some(model))
    {
        spec.insert("model", Value::from(model));
    }
    let resolution = catalog.resolve(&Value::Object(spec))?;
    if !resolution
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return reject(catalog, provider, model, instance);
    }
    // A resolution's model is the catalog row itself (`CatalogModel`), not its id: the provider's
    // launch id is `executionModelId(row)` (`execution-id.ts:8`).
    let Some(row) = resolution.get("model") else {
        return reject(catalog, provider, model, instance);
    };
    let Some(native_model_id) = row.get("nativeModelId").and_then(Value::as_str) else {
        return reject(catalog, provider, model, instance);
    };
    let native_provider_id = row.get("nativeProviderId").and_then(Value::as_str);
    Ok(Some(execution_model_id(native_model_id, native_provider_id)))
}

fn reject(
    catalog: &dyn Catalog,
    provider: &str,
    model: Option<&str>,
    instance: Option<&str>,
) -> Result<Option<String>, EngineError> {
    let Some(model) = model.filter(|model| !is_default_selection(Some(model))) else {
        return Ok(None);
    };
    catalog.rejected(provider, model, instance);
    Err(EngineError::ModelUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        list: Value,
        resolve: Value,
        updated: RefCell<Vec<(String, Value)>>,
        rejected: RefCell<Vec<(String, String, Option<String>)>>,
    }

    impl Catalog for Fake {
        fn resolve(&self, _spec: &Value) -> Result<Value, EngineError> {
            Ok(self.resolve.clone())
        }
        fn list(&self, _options: &Value) -> Result<Value, EngineError> {
            Ok(self.list.clone())
        }
        fn update_permission_modes(
            &self,
            instance: &str,
            modes: &Value,
        ) -> Result<(), EngineError> {
            self.updated
                .borrow_mut()
                .push((instance.to_owned(), modes.clone()));
            Ok(())
        }
        fn rejected(&self, provider: &str, model: &str, instance: Option<&str>) {
            self.rejected.borrow_mut().push((
                provider.to_owned(),
                model.to_owned(),
                instance.map(str::to_owned),
            ));
        }
    }

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    /// A `ModelResolution` as `models.resolve` returns it: `model` is the whole `CatalogModel`
    /// row (`packages/protocol/src/models.ts:200`-`:208`), required fields and all.
    fn resolved(native_model_id: &str, native_provider_id: Option<&str>) -> Value {
        value(&crate::repository::testsupport::model_resolution(
            native_model_id,
            native_provider_id,
        ))
    }

    #[test]
    fn without_a_catalog_select_is_the_default_sentinel_rule() {
        assert_eq!(select(None, "codex", None, None, None).unwrap(), None);
        assert_eq!(
            select(None, "codex", Some("default"), None, None).unwrap(),
            None
        );
        assert_eq!(
            select(None, "codex", Some("gpt-5"), None, None).unwrap(),
            Some("gpt-5".to_owned())
        );
    }

    #[test]
    fn a_resolved_model_crosses_as_its_execution_id() {
        let catalog = Fake {
            resolve: resolved("gpt-5", None),
            ..Fake::default()
        };
        assert_eq!(
            select(Some(&catalog), "codex", None, Some("acct"), None).unwrap(),
            Some("gpt-5".to_owned())
        );
        assert!(catalog.rejected.borrow().is_empty());
        // A row with a source provider launches as `provider/model` (`execution-id.ts:8`).
        let catalog = Fake {
            resolve: resolved("claude-sonnet", Some("anthropic")),
            ..Fake::default()
        };
        assert_eq!(
            select(Some(&catalog), "codex", Some("claude-sonnet"), None, None).unwrap(),
            Some("anthropic/claude-sonnet".to_owned())
        );
    }

    #[test]
    fn an_explicit_model_the_catalog_cannot_resolve_is_model_unavailable() {
        let catalog = Fake {
            resolve: value(r#"{"ok":false}"#),
            ..Fake::default()
        };
        let error = select(Some(&catalog), "codex", Some("gpt-9"), Some("acct"), None).unwrap_err();
        assert_eq!(error.to_string(), "model_unavailable");
        assert_eq!(
            catalog.rejected.borrow().as_slice(),
            &[(
                "codex".to_owned(),
                "gpt-9".to_owned(),
                Some("acct".to_owned())
            )]
        );
        // The default sentinel falls back silently instead.
        assert_eq!(
            select(Some(&catalog), "codex", Some("default"), None, None).unwrap(),
            None
        );
        assert_eq!(catalog.rejected.borrow().len(), 1);
    }

    #[test]
    fn an_acp_row_without_its_identity_is_unavailable_for_an_explicit_model() {
        let catalog = Fake {
            resolve: resolved("agent/model", None),
            ..Fake::default()
        };
        assert_eq!(
            select(Some(&catalog), "acp", Some("agent/model"), None, None)
                .unwrap_err()
                .to_string(),
            "model_unavailable"
        );
        let identity = value(r#"{"acpAgentId":"a","installationId":"i","instanceId":"s"}"#);
        assert_eq!(
            select(Some(&catalog), "acp", None, None, Some(&identity)).unwrap(),
            Some("agent/model".to_owned())
        );
    }

    #[test]
    fn the_catalogs_modes_merge_into_the_capabilities() {
        let catalog = Fake {
            list: value(
                r#"{"instances":[{"instance":"acct","permissionModes":[{"id":"plan"},{"id":"edit"}],"accessModes":["read"]}]}"#,
            ),
            ..Fake::default()
        };
        let base = value(r#"{"permissions":{"permissionModes":[],"modes":[]}}"#);
        let merged =
            permission_capabilities(Some(&catalog), "claude", Some("acct"), &base).unwrap();
        assert_eq!(
            ace_json::to_string(&merged),
            r#"{"permissions":{"permissionModes":[{"id":"plan"},{"id":"edit"}],"modes":["plan","edit"]},"permissionModes":[{"id":"plan"},{"id":"edit"}],"accessModes":["read"]}"#
        );
        // No modes reported leaves the base untouched.
        let unknown = Fake::default();
        assert_eq!(
            permission_capabilities(Some(&unknown), "claude", Some("acct"), &base).unwrap(),
            base
        );
        // No permissions block means no merge either.
        let bare = value(r#"{"permissions":null}"#);
        assert_eq!(
            permission_capabilities(Some(&catalog), "claude", Some("acct"), &bare).unwrap(),
            bare
        );
    }

    #[test]
    fn a_reported_mode_list_is_written_to_the_instance() {
        let catalog = Fake::default();
        let modes = value(r#"[{"id":"plan"}]"#);
        permissions(
            Some(&catalog),
            Some("acct"),
            &value(r#"{"permissionModes":[{"id":"plan"}]}"#),
        )
        .unwrap();
        assert_eq!(
            catalog.updated.borrow().as_slice(),
            &[("acct".to_owned(), modes)]
        );
        // An absent list or instance writes nothing.
        permissions(Some(&catalog), Some("acct"), &value("{}")).unwrap();
        permissions(Some(&catalog), None, &value(r#"{"permissionModes":[]}"#)).unwrap();
        assert_eq!(catalog.updated.borrow().len(), 1);
    }
}
